# Refresh Tab And Refresh Pane Context Menus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add `Refresh Tab` and `Refresh Pane` to the existing right-click context menus so browser panes reload in place and terminal panes recover by re-establishing the frontend connection to the existing pane session, including tabs that are currently zoomed.

**Architecture:** Make refresh state-driven, not mounted-component-driven. Add an ephemeral `refreshByPane` generation map to `panesSlice`, plus reducers that mark one pane or every refreshable leaf in a tab’s stored layout tree for refresh regardless of what `PaneLayout` is currently mounting. `TerminalView` and `BrowserPane` will subscribe to their pane’s refresh generation and execute the real recovery logic themselves: terminals send detach plus attach with the existing broker helpers, and browsers use a new state-driven reload primitive that retries both live iframes and error screens. `ContextMenuProvider` and `menu-defs` should only determine whether a pane is refreshable from layout content kinds, then dispatch refresh requests; they must not depend on action registries for correctness.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, xterm.js, Vitest, Testing Library

---

## Scope Notes

- `Refresh Pane` belongs on the pane chrome context menu (`ContextIds.Pane`), not the inner terminal/browser/editor content menus.
- `Refresh Tab` must iterate the entire stored tab layout tree, not just currently mounted leaves.
- `PaneLayout` renders only the zoomed leaf when a tab is zoomed (`src/components/panes/PaneLayout.tsx:66-72`), so refresh cannot be implemented by asking mounted components what actions they currently expose.
- Refresh requests must be ephemeral UI/runtime state like `renameRequest*` and `zoomedPane`, not persisted to localStorage.
- Refreshable pane kinds for this issue:
  - `terminal`
  - `browser`
- Non-refreshable pane kinds for now:
  - `editor`
  - `picker`
  - `agent-chat`
  - `extension`
- Mounted panes should refresh immediately.
- Unmounted panes in a zoomed tab should receive a pending refresh request and execute it when they next mount; this is how `Refresh Tab` remains correct in zoomed layouts.
- Browser refresh must use the same robust primitive for the toolbar button, registered browser action, pane context menu, and deferred refresh requests.
- No server-side protocol changes are needed.
- No `docs/index.html` update is required; this is not a major UI mock change.

### Task 1: Add Shared Pane Refreshability Helpers

**Files:**
- Modify: `src/lib/pane-utils.ts:1-54`
- Test: `test/unit/client/lib/pane-utils.test.ts:1-45`

**Step 1: Write the failing test**

Extend `test/unit/client/lib/pane-utils.test.ts` with refreshability coverage alongside the existing leaf traversal tests:

```ts
import { collectPaneLeaves, isRefreshablePaneContent } from '@/lib/pane-utils'

describe('collectPaneLeaves', () => {
  it('returns leaf ids in tree order', () => {
    const tree = split([
      split([leaf('p1', shellContent), leaf('p2', browserContent)]),
      leaf('p3', editorContent),
    ])

    expect(collectPaneLeaves(tree).map((leaf) => leaf.id)).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('isRefreshablePaneContent', () => {
  it('returns true for terminal and browser panes', () => {
    expect(isRefreshablePaneContent(shellContent)).toBe(true)
    expect(isRefreshablePaneContent(browserContent)).toBe(true)
  })

  it('returns false for editor and picker panes', () => {
    expect(isRefreshablePaneContent(editorContent)).toBe(false)
    expect(isRefreshablePaneContent({ kind: 'picker' })).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: FAIL because `collectPaneLeaves` and `isRefreshablePaneContent` are not exported yet.

**Step 3: Write minimal implementation**

Update `src/lib/pane-utils.ts`:

```ts
export function collectPaneLeaves(node: PaneNode): Array<Extract<PaneNode, { type: 'leaf' }>> {
  if (node.type === 'leaf') return [node]
  return [...collectPaneLeaves(node.children[0]), ...collectPaneLeaves(node.children[1])]
}

export function isRefreshablePaneContent(content: PaneContent): boolean {
  return content.kind === 'terminal' || content.kind === 'browser'
}
```

Keep `findPaneContent` and `collectPaneContents` as-is; they are still used elsewhere.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/pane-utils.ts test/unit/client/lib/pane-utils.test.ts
git commit -m "test(panes): add shared refreshability helpers"
```

### Task 2: Add Ephemeral Refresh Requests To `panesSlice`

**Files:**
- Modify: `src/store/paneTypes.ts:168-205`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistMiddleware.ts:303-321`
- Test: `test/unit/client/store/panesSlice.test.ts:1-120`
- Test: `test/unit/client/store/panesPersistence.test.ts:1-120`

**Step 1: Write the failing tests**

Add reducer tests to `test/unit/client/store/panesSlice.test.ts`:

```ts
import { requestPaneRefresh, requestTabRefresh } from '../../../../src/store/panesSlice'

describe('requestPaneRefresh', () => {
  it('increments refresh generation for a terminal pane', () => {
    const state = panesReducer(
      stateWithLeaf('pane-term', { kind: 'terminal', mode: 'shell' }),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-term' }),
    )

    expect(state.refreshByPane['tab-1']['pane-term']).toBe(1)
  })

  it('does not create refresh state for unsupported panes', () => {
    const state = panesReducer(
      stateWithLeaf('pane-editor', editorContent),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-editor' }),
    )

    expect(state.refreshByPane['tab-1']).toBeUndefined()
  })
})

describe('requestTabRefresh', () => {
  it('increments every refreshable leaf in the stored layout tree', () => {
    const state = panesReducer(
      stateWithLayoutAndZoom({
        layout: split([
          leaf('pane-term', shellContent),
          split([leaf('pane-browser', browserContent), leaf('pane-editor', editorContent)]),
        ]),
        zoomedPaneId: 'pane-editor',
      }),
      requestTabRefresh({ tabId: 'tab-1' }),
    )

    expect(state.refreshByPane['tab-1']).toEqual({
      'pane-term': 1,
      'pane-browser': 1,
    })
  })
})
```

Add a persistence test to `test/unit/client/store/panesPersistence.test.ts`:

```ts
it('does not persist refreshByPane', () => {
  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })

  store.dispatch(addTab({ mode: 'shell' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, paneId: 'pane-1', content: { kind: 'terminal', mode: 'shell' } }))
  store.dispatch(requestPaneRefresh({ tabId, paneId: 'pane-1' }))

  vi.runAllTimers()
  const saved = JSON.parse(localStorage.getItem('freshell.panes.v2')!)
  expect(saved.refreshByPane).toBeUndefined()
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: FAIL because `PanesState` and the reducers do not yet support refresh generations.

**Step 3: Write minimal implementation**

First extend `PanesState` in `src/store/paneTypes.ts`:

```ts
/**
 * Ephemeral refresh generations by tab and pane.
 * Incrementing a pane generation requests that pane to repair itself on the next render/mount.
 * Must never be persisted.
 */
refreshByPane: Record<string, Record<string, number>>
```

Initialize it everywhere `PanesState` is created in `src/store/panesSlice.ts`.

Add reducers in `src/store/panesSlice.ts`:

```ts
requestPaneRefresh: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string }>
) => {
  const { tabId, paneId } = action.payload
  const layout = state.layouts[tabId]
  const content = layout ? findLeaf(layout, paneId)?.content : null
  if (!content || !isRefreshablePaneContent(content)) return

  if (!state.refreshByPane[tabId]) state.refreshByPane[tabId] = {}
  state.refreshByPane[tabId][paneId] = (state.refreshByPane[tabId][paneId] ?? 0) + 1
},

requestTabRefresh: (
  state,
  action: PayloadAction<{ tabId: string }>
) => {
  const { tabId } = action.payload
  const layout = state.layouts[tabId]
  if (!layout) return

  for (const leaf of collectPaneLeaves(layout)) {
    if (!isRefreshablePaneContent(leaf.content)) continue
    if (!state.refreshByPane[tabId]) state.refreshByPane[tabId] = {}
    state.refreshByPane[tabId][leaf.id] = (state.refreshByPane[tabId][leaf.id] ?? 0) + 1
  }
},
```

Also clean up `refreshByPane` in reducers that remove panes/tabs:

- `closePane`
- `removeLayout`
- orphan-layout cleanup during initial state load

Then update `src/store/persistMiddleware.ts` to strip `refreshByPane` alongside the other ephemeral fields:

```ts
const {
  renameRequestTabId: _rrt,
  renameRequestPaneId: _rrp,
  zoomedPane: _zp,
  refreshByPane: _rbp,
  ...persistablePanes
} = state.panes
```

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "feat(panes): add ephemeral pane refresh generations"
```

### Task 3: Add Layout-Based Refresh Menu Items In `menu-defs`

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts:1-220`

**Step 1: Write the failing tests**

Extend `test/unit/client/components/context-menu/menu-defs.test.ts`:

```ts
it('enables Refresh tab when the stored layout has refreshable leaves even without mounted action registries', () => {
  const actions = createMockActions()
  const ctx = {
    ...createMockContext(actions),
    paneLayouts: {
      tab1: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-editor', content: editorContent },
          { type: 'leaf', id: 'pane-browser', content: browserContent },
        ],
      },
    },
  }

  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')

  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : true).toBe(false)
})

it('disables Refresh tab when no leaf in the layout is refreshable', () => {
  const actions = createMockActions()
  const ctx = {
    ...createMockContext(actions),
    paneLayouts: {
      tab1: { type: 'leaf', id: 'pane-editor', content: editorContent },
    },
  }

  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')

  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : false).toBe(true)
})

it('selecting Refresh pane calls refreshPane', () => {
  const actions = createMockActions()
  const ctx = createMockContext(actions)
  const items = buildMenuItems({ kind: 'pane', tabId: 'tab1', paneId: 'pane1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-pane')

  expect(refreshItem).toBeDefined()
  if (refreshItem?.type === 'item') refreshItem.onSelect()
  expect(actions.refreshPane).toHaveBeenCalledWith('tab1', 'pane1')
})
```

Update `createMockActions()` with `refreshTab` and `refreshPane`.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: FAIL because the new menu items and action fields do not exist yet.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`:

```ts
export type MenuActions = {
  // existing fields...
  refreshTab: (tabId: string) => void
  refreshPane: (tabId: string, paneId: string) => void
}
```

Use `collectPaneLeaves()` and `isRefreshablePaneContent()` to compute enablement from the stored layout itself:

```ts
const canRefreshTab = !!layout && collectPaneLeaves(layout).some((leaf) => isRefreshablePaneContent(leaf.content))
```

```ts
const canRefreshPane = !!paneContent && isRefreshablePaneContent(paneContent)
```

Insert:

```ts
{ type: 'item', id: 'refresh-tab', label: 'Refresh tab', onSelect: () => actions.refreshTab(target.tabId), disabled: !canRefreshTab }
```

and:

```ts
{ type: 'item', id: 'refresh-pane', label: 'Refresh pane', onSelect: () => actions.refreshPane(target.tabId, target.paneId), disabled: !canRefreshPane }
```

Placement:

- `Refresh tab` before `Rename tab`
- `Refresh pane` before the split actions

Do not read `getTerminalActions()` or `getBrowserActions()` for refresh enablement.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/components/context-menu/menu-defs.test.ts
git commit -m "feat(ui): add layout-driven refresh menu items"
```

### Task 4: Dispatch Refresh Requests From `ContextMenuProvider`

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/panes/Pane.tsx:61-104`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing tests**

Add provider tests that exercise the real store state instead of registry stubs:

```tsx
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import { toggleZoom } from '@/store/panesSlice'

it('opens the pane context menu from the focused pane shell with Shift+F10', async () => {
  const user = userEvent.setup()
  const { store } = renderRealPaneHarness()

  const pane = screen.getByRole('group', { name: 'Pane: Shell' })
  pane.focus()
  await user.keyboard('{Shift>}{F10}{/Shift}')

  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})

it('Refresh pane increments refresh generation for the targeted pane', async () => {
  const user = userEvent.setup()
  const { store } = renderRealPaneHarness()

  await user.pointer({ target: screen.getByText('Shell'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

  expect(store.getState().panes.refreshByPane['tab-1']['pane-1']).toBe(1)
})

it('Refresh tab marks all refreshable leaves in a zoomed tab, including unmounted siblings', async () => {
  const user = userEvent.setup()
  const store = createZoomedStore({
    layout: split([
      leaf('pane-editor', editorContent),
      split([leaf('pane-term', shellContent), leaf('pane-browser', browserContent)]),
    ]),
    zoomedPaneId: 'pane-editor',
  })

  render(
    <Provider store={store}>
      <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
        <TabBar />
        <TabContent tabId="tab-1" hidden={false} />
      </ContextMenuProvider>
    </Provider>,
  )

  await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

  expect(store.getState().panes.refreshByPane['tab-1']).toEqual({
    'pane-term': 1,
    'pane-browser': 1,
  })
})
```

That zoomed-tab test is the key regression: only the editor leaf is mounted, but the hidden terminal and browser siblings must still be marked for refresh.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL because the provider does not dispatch refresh reducers yet and the pane shell is not yet the keyboard context target.

**Step 3: Write minimal implementation**

Move the pane context metadata onto the focusable pane shell in `src/components/panes/Pane.tsx`:

```tsx
<div
  data-pane-shell="true"
  data-context={ContextIds.Pane}
  data-tab-id={tabId}
  data-pane-id={paneId}
  role="group"
  tabIndex={0}
  aria-label={`Pane: ${title || 'untitled'}`}
>
```

Then update `src/components/context-menu/ContextMenuProvider.tsx`:

```ts
const refreshPaneAction = useCallback((tabId: string, paneId: string) => {
  dispatch(requestPaneRefresh({ tabId, paneId }))
}, [dispatch])

const refreshTabAction = useCallback((tabId: string) => {
  dispatch(requestTabRefresh({ tabId }))
}, [dispatch])
```

Wire them into the menu action map:

```ts
actions: {
  // existing actions...
  refreshTab: refreshTabAction,
  refreshPane: refreshPaneAction,
}
```

Do not call browser or terminal action registries here. The provider’s job is to mark refresh intent in state.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS, including the zoomed-tab regression.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "feat(ui): dispatch pane refresh requests from context menus"
```

### Task 5: Refactor `BrowserPane` Refresh To Recover Error Screens

**Files:**
- Modify: `src/components/panes/BrowserPane.tsx`
- Test: `test/unit/client/components/panes/BrowserPane.test.tsx`

**Step 1: Write the failing tests**

Add real BrowserPane tests that verify behavior, not a fake registry callback:

```tsx
import { requestPaneRefresh } from '@/store/panesSlice'

it('toolbar Refresh retries a forwarded URL after forwardError', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  const { store } = renderBrowserPane({ url: 'http://localhost:3000' })

  await waitFor(() => expect(screen.getByText('Failed to connect')).toBeInTheDocument())

  await act(async () => {
    fireEvent.click(screen.getByTitle('Refresh'))
  })

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('http://192.168.1.100:45678/')
  })
})

it('toolbar Refresh reloads a direct URL even when the iframe src string is unchanged', async () => {
  setWindowHostname('localhost')
  renderBrowserPane({ url: 'https://example.com' })

  const firstIframe = document.querySelector('iframe')
  expect(firstIframe).toBeTruthy()

  fireEvent.click(screen.getByTitle('Refresh'))

  await waitFor(() => {
    const nextIframe = document.querySelector('iframe')
    expect(nextIframe).toBeTruthy()
    expect(nextIframe).not.toBe(firstIframe)
    expect(nextIframe!.getAttribute('src')).toBe('https://example.com')
  })
})

it('dispatching requestPaneRefresh retries the same browser recovery path', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  const { store } = renderBrowserPane({ url: 'http://localhost:3000' })

  await waitFor(() => expect(screen.getByText('Failed to connect')).toBeInTheDocument())

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
  })

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(2)
  })
})

it('consumes a pre-existing refresh generation on mount', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })
  const store = createMockStoreWithRefresh({ 'tab-1': { 'pane-1': 1 } })

  renderBrowserPane({ url: 'http://localhost:3000' }, store)

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 3000 })
  })
})
```

These tests must inspect real DOM and API behavior; do not replace refresh with a fake `browserReload` spy.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: FAIL because the current `refresh()` returns early when no iframe exists and does not react to `refreshByPane`.

**Step 3: Write minimal implementation**

Refactor `src/components/panes/BrowserPane.tsx` so refresh is state-driven instead of DOM-driven:

1. Select the pane’s refresh generation:

```ts
const refreshGeneration = useAppSelector((s) => s.panes.refreshByPane[tabId]?.[paneId] ?? 0)
const handledRefreshGenerationRef = useRef(0)
```

2. Replace `forwardRetryKey` with a generic resolve attempt key and add an iframe remount key:

```ts
const [resolveAttemptKey, setResolveAttemptKey] = useState(0)
const [iframeInstanceKey, setIframeInstanceKey] = useState(0)
```

3. Replace the current DOM-only `refresh()` with a state reset:

```ts
const refreshBrowser = useCallback(() => {
  if (!currentUrl) return

  setLoadError(null)
  setForwardError(null)
  setResolvedSrc(null)
  setIsLoading(true)
  setResolveAttemptKey((k) => k + 1)
  setIframeInstanceKey((k) => k + 1)
}, [currentUrl])
```

4. Make the URL-resolution effect depend on `resolveAttemptKey` instead of only `currentUrl`.
5. Render the iframe with `key={iframeInstanceKey}` so a same-URL refresh produces a real remount.
6. Reuse `refreshBrowser` for:
   - the toolbar Refresh button
   - the registered browser action (`reload`)
   - a `useEffect` that consumes new refresh generations:

```ts
useEffect(() => {
  if (refreshGeneration <= handledRefreshGenerationRef.current) return
  handledRefreshGenerationRef.current = refreshGeneration
  refreshBrowser()
}, [refreshGeneration, refreshBrowser])
```

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/panes/BrowserPane.tsx test/unit/client/components/panes/BrowserPane.test.tsx
git commit -m "fix(browser): make refresh recover iframe and error states"
```

### Task 6: Make `TerminalView` Consume Refresh Generations

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing tests**

Add terminal refresh-generation coverage to `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
import { requestPaneRefresh } from '@/store/panesSlice'

it('dispatching requestPaneRefresh detaches and viewport-reattaches a visible terminal', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-refresh-visible' })

  wsMocks.send.mockClear()

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId, paneId }))
  })

  expect(wsMocks.send).toHaveBeenNthCalledWith(1, { type: 'terminal.detach', terminalId })
  expect(wsMocks.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
    type: 'terminal.attach',
    terminalId,
    sinceSeq: 0,
    attachRequestId: expect.any(String),
  }))
})

it('dispatching requestPaneRefresh while hidden keeps the delta path and defers viewport hydrate', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-refresh-hidden', hidden: true })

  messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
  wsMocks.send.mockClear()

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId, paneId }))
  })

  expect(wsMocks.send).toHaveBeenNthCalledWith(1, { type: 'terminal.detach', terminalId })
  expect(wsMocks.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
    type: 'terminal.attach',
    terminalId,
    sinceSeq: 3,
    attachRequestId: expect.any(String),
  }))
})

it('consumes a pre-existing refresh generation when a terminal mounts after being skipped by zoom', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-refresh-on-mount',
    refreshGeneration: 1,
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.detach',
      terminalId,
    }))
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because `TerminalView` does not react to `refreshByPane` yet.

**Step 3: Write minimal implementation**

In `src/components/TerminalView.tsx`:

1. Select refresh generation:

```ts
const refreshGeneration = useAppSelector((s) => s.panes.refreshByPane[tabId]?.[paneId] ?? 0)
const handledRefreshGenerationRef = useRef(0)
```

2. Add a dedicated refresh effect after the attach helpers are defined:

```ts
useEffect(() => {
  if (!isTerminal) return
  if (refreshGeneration <= handledRefreshGenerationRef.current) return

  handledRefreshGenerationRef.current = refreshGeneration

  const tid = terminalIdRef.current
  if (!tid) return

  ws.send({ type: 'terminal.detach', terminalId: tid })
  currentAttachRef.current = null

  if (hiddenRef.current) {
    needsViewportHydrationRef.current = true
    attachTerminal(tid, 'keepalive_delta')
    return
  }

  attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
}, [refreshGeneration, isTerminal, attachTerminal, ws])
```

Key rules:

- Do not add a new server message type.
- Do not create a separate terminal refresh registry method for menus; refresh comes from slice state now.
- If there is no `terminalId` yet, do nothing; the existing create flow already yields a fresh frontend connection.
- Hidden terminals must stay on the delta path so the existing deferred viewport-hydration behavior remains intact.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(terminals): consume pane refresh generations"
```

### Task 7: Add A Zoomed-Tab Refresh Regression Flow

**Files:**
- Create: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing test**

Create a flow that combines the zoomed-tab state model with the real components:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { toggleZoom } from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { api } from '@/lib/api'

describe('refresh context menu flow', () => {
  it('Refresh tab marks unmounted zoom siblings and they refresh when later mounted', async () => {
    const user = userEvent.setup()
    const store = createZoomedBrowserSiblingStore()

    render(
      <Provider store={store}>
        <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
          <TabBar />
          <TabContent tabId="tab-1" hidden={false} />
        </ContextMenuProvider>
      </Provider>,
    )

    // The tab is zoomed onto an editor leaf; browser sibling is not mounted.
    expect(screen.queryByTitle('Back')).toBeNull()

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

    expect(store.getState().panes.refreshByPane['tab-1']['pane-browser']).toBe(1)

    store.dispatch(toggleZoom({ tabId: 'tab-1', paneId: 'pane-editor' }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalled()
    })
  })
})
```

Use a zoomed editor leaf plus a hidden browser leaf with a localhost URL so the unzoom step has an externally visible retry signal (`api.post('/api/proxy/forward', ...)`).

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: FAIL until Tasks 2-6 are complete.

**Step 3: Write minimal implementation**

Finish the test with the real store shape and mocks that the app already uses. The important assertions are:

- `Refresh tab` remains enabled while only the zoomed editor leaf is mounted.
- Clicking it increments refresh generations for hidden refreshable siblings.
- Unzooming later causes the previously skipped browser sibling to execute its pending refresh.

This test should not pre-register hidden pane action registries; that would reintroduce the bug the test is supposed to catch.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "test(ui): cover zoomed tab refresh flow"
```

## Final Validation

Run the focused client suite first:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Then run the repo gates:

```bash
npm run lint
npm test
```

Expected final state:

- Right-clicking a tab shows `Refresh tab`.
- Right-clicking a pane header shows `Refresh pane`.
- Menu enablement depends on the stored pane content kinds, not mounted component registries.
- `Refresh Tab` marks every terminal/browser leaf in the tab’s layout tree, even in zoomed tabs where siblings are currently unmounted.
- Mounted terminal panes detach plus re-attach to the same PTY.
- Mounted browser panes retry from both live iframes and error screens.
- Previously unmounted zoom siblings execute pending refreshes when they later mount.
- Refresh bookkeeping is ephemeral and is not persisted to localStorage.

If `npm test` surfaces unrelated failures, stop and fix them before rebasing or merging, per repo policy.
