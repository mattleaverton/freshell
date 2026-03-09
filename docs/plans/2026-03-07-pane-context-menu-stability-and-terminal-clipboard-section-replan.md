# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open long enough to use, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two contracts, not one theory. The menu-layout change is deterministic and belongs entirely in `src/components/context-menu/menu-defs.ts`, backed by menu-definition tests plus one rendered DOM smoke. The reclose bug must be proven on real rendered pane routes before changing production code: add regressions for right-clicking an inactive pane header and an inactive terminal body, then fix the smallest shared seam that those routes expose. `Pane` is the first justified production seam because it currently focuses on every mouse button; only widen into `TerminalView` if the terminal-body regression remains red after the pane fix.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, Vite dev server, xterm.js mocks

---

## Strategy Gate

- Solve the user’s actual request only: stop the menu from reclosing immediately and reorganize the terminal clipboard actions. Do not rewrite the menu system.
- The user did **not** ask for “right-click should never activate a pane.” Do not turn that into a product contract. The only required behavior is that the menu stays open long enough to use.
- Prior trycycle rounds drifted by anchoring on one unproved story. Do not start from theory. Start from a rendered failing route on the real UI surface.
- Existing coverage already proves active pane-shell menus are usable: `test/e2e/refresh-context-menu-flow.test.tsx` opens the pane-shell menu and successfully executes actions. The missing coverage is the inactive-pane path and the terminal-body path.
- Cover the two real user-facing entry points that matter here:
  - inactive pane header -> pane menu
  - inactive terminal body -> terminal menu
- Keep browser-pane automation out of the mainline. The shared pane-shell fix should be manually sanity-checked on a browser pane in the browser spot-check.
- The accepted medium strategy requires one real browser spot-check after automated tests. That is mandatory.

## Diagnostic Carry-Forward

- Fresh diagnostic guidance for the implementer: earlier loops kept failing because they treated conjectures as requirements. Do not add new framing while executing this plan. Forward evidence from failing tests directly.
- If the pane-level fix clears both user-facing regressions, stop. Do not widen the fix surface just because `TerminalView` also contains focus logic.
- If the terminal-body regression remains red after the pane-level fix, prove the remaining close source before editing `TerminalView`.

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is localized UI behavior, not a new feature surface.
- Preserve the existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Keep `ContextMenu` as the renderer. The icon work belongs in menu item definitions, not in a renderer rewrite.
- Preserve current `Paste` and `Select all` labels unless a test or product requirement proves otherwise. Only `copy` must change text.
- The terminal-body regression must right-click a descendant created inside `data-testid="terminal-xterm-container"`. Right-clicking the wrapper alone does not count as terminal-body coverage.

### Task 1: Reproduce The User-Visible Reclose Bug On Real Inactive-Pane Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`
- Modify: `test/unit/client/components/panes/Pane.test.tsx`

**Step 1: Create a dedicated e2e harness for inactive-pane context-menu stability**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Copy the `createStore(...)` and `renderFlow(...)` shape from `test/e2e/refresh-context-menu-flow.test.tsx` so this file exercises `PaneLayout` under the real `ContextMenuProvider`.

At the top of the file, add a local xterm mock that appends an actual child surface inside the terminal container:

```tsx
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    openedSurface: HTMLElement | null = null
    focus = vi.fn()
    open = vi.fn((element: HTMLElement) => {
      const surface = document.createElement('div')
      surface.setAttribute('data-testid', 'terminal-xterm-surface')
      surface.tabIndex = -1
      element.appendChild(surface)
      this.openedSurface = surface
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn(() => {
      this.openedSurface?.remove()
      this.openedSurface = null
    })
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    paste = vi.fn()
    reset = vi.fn()
    selectAll = vi.fn()
    scrollLines = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    scrollToBottom = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
```

Add these helpers:

```tsx
function createTerminalLeaf(id: string, terminalId: string): Extract<PaneNode, { type: 'leaf' }> {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      terminalId,
      createRequestId: `req-${terminalId}`,
      status: 'running',
      mode: 'shell',
      shell: 'system',
    },
  }
}

function createTerminalSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-terminal',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
}

async function waitForMenuToSettle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
```

Use the same `MockResizeObserver` setup pattern the other terminal e2e tests already use.

**Step 2: Add the two missing user-facing regressions**

In that same new file, add these tests:

```tsx
it('keeps the pane menu open when right-clicking an inactive pane header', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')

  const inactiveHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
  ) as HTMLElement | null
  expect(inactiveHeader).not.toBeNull()

  await user.pointer({ target: inactiveHeader as HTMLElement, keys: '[MouseRight]' })
  await waitForMenuToSettle()

  expect(screen.getByRole('menu')).toBeInTheDocument()
})

it('keeps the terminal menu open when right-clicking inside an inactive terminal body', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')

  const terminalSurface = await waitFor(() => {
    const node = container.querySelector(
      '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-surface"]',
    ) as HTMLElement | null
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await user.pointer({ target: terminalSurface, keys: '[MouseRight]' })
  await waitForMenuToSettle()

  expect(screen.getByRole('menu')).toBeInTheDocument()
})
```

These two tests are the behavioral source of truth for the bug. Do not add broader matrices yet.

**Step 3: Add a focused pane seam regression**

In `test/unit/client/components/panes/Pane.test.tsx`, add:

```tsx
it('does not call onFocus on secondary-button mouse down', () => {
  const onFocus = vi.fn()

  const { container } = render(
    <Pane
      tabId="t1"
      paneId="p1"
      isActive={false}
      isOnlyPane={false}
      onClose={vi.fn()}
      onFocus={onFocus}
    >
      <div>Content</div>
    </Pane>
  )

  fireEvent.mouseDown(container.firstChild as HTMLElement, { button: 2 })

  expect(onFocus).not.toHaveBeenCalled()
})
```

Keep the existing primary-button focus test unchanged.

**Step 4: Run the new regressions and confirm the bug is red before changing production code**

Run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected:
- the new `Pane.test.tsx` secondary-button regression fails
- at least one inactive-pane route in `pane-context-menu-stability.test.tsx` fails

Do not edit production code until that happens.

### Task 2: Fix The Shared Secondary-Button Pane Seam First

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Re-run: `test/unit/client/components/panes/Pane.test.tsx`
- Re-run: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Implement the minimal pane-level fix**

In `src/components/panes/Pane.tsx`, replace the unconditional focus hook with a primary-button-only guard:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

Do not touch keyboard focus handling. Do not add menu-specific state to `Pane`.

**Step 2: Re-run the focused regressions**

Run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected:
- the secondary-button seam test passes
- the inactive pane-header regression passes
- if the inactive terminal-body regression also passes, skip Task 3 entirely

### Task 3: Only If Needed, Add The Narrow Terminal-Body Follow-Up

**Files:**
- Modify only if the inactive terminal-body regression is still red:
  - `src/components/TerminalView.tsx`
  - `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Prove that terminal refocus is the remaining close source**

If the pane-header route is green but the terminal-body route is still red, extend the same e2e file with one diagnostic assertion before touching production code:

- keep the mock terminal `focus` method as `vi.fn()`
- record its call count immediately before the right-click
- assert whether the count increases during the settle window where the menu recloses

Treat `TerminalView` as justified only if that count rises while the menu disappears.

**Step 2: Add the smallest local guard in `TerminalView.tsx`**

If Step 1 proves post-activation terminal focus is the remaining cause, add a local suppression ref:

```ts
const suppressAutoFocusRef = useRef(false)
```

Mark it from the terminal root:

```tsx
onContextMenuCapture={() => {
  suppressAutoFocusRef.current = true
  requestAnimationFrame(() => {
    suppressAutoFocusRef.current = false
  })
}}
```

Guard only the active-terminal focus effect near `shouldFocusActiveTerminal`:

```ts
requestAnimationFrame(() => {
  if (termRef.current !== term) return
  if (suppressAutoFocusRef.current) return
  term.focus()
})
```

Do not change unrelated `focus()` calls unless the failing regression proves they are part of this exact close path.

**Step 3: Re-run the stability file**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: PASS.

**Step 4: Commit the stability fix**

If Task 3 was skipped:

```bash
git add src/components/panes/Pane.tsx test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

If Task 3 ran:

```bash
git add src/components/panes/Pane.tsx src/components/TerminalView.tsx test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

### Task 4: Lock Down The Terminal Clipboard Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Repair the authoritative terminal menu harness and add failing behavior tests**

In `test/unit/client/context-menu/menu-defs.test.ts`, rename the stale `copyFreshclaude*` mocks in `createActions()` to the current `copyAgentChat*` names so the helper matches `MenuActions`.

Then add these helpers near `makeCtx(...)`:

```ts
function getTerminalItem(items: ReturnType<typeof buildMenuItems>, id: string) {
  const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
  expect(item?.type).toBe('item')
  if (!item || item.type !== 'item') {
    throw new Error(`Missing terminal menu item: ${id}`)
  }
  return item
}

function createTerminalMenuHarness(options?: { hasSelection?: boolean; withActions?: boolean }) {
  const terminalActions = options?.withActions === false
    ? undefined
    : {
        copySelection: vi.fn(),
        paste: vi.fn(),
        selectAll: vi.fn(),
        clearScrollback: vi.fn(),
        reset: vi.fn(),
        scrollToBottom: vi.fn(),
        hasSelection: vi.fn(() => options?.hasSelection ?? false),
        openSearch: vi.fn(),
      }

  const actions = createActions()
  actions.getTerminalActions = vi.fn(() => terminalActions)

  const items = buildMenuItems(
    { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
    makeCtx(actions),
  )

  return { items, terminalActions }
}
```

Add these failing tests:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('places copy, Paste, and Select all in the first section with icons and keeps Search later', () => {
    const { items } = createTerminalMenuHarness()

    expect(
      items.slice(0, 4).map((item) => item.type === 'item' ? item.id : item.type),
    ).toEqual([
      'terminal-copy',
      'terminal-paste',
      'terminal-select-all',
      'separator',
    ])

    const copyItem = getTerminalItem(items, 'terminal-copy')
    const pasteItem = getTerminalItem(items, 'terminal-paste')
    const selectAllItem = getTerminalItem(items, 'terminal-select-all')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(copyItem.label).toBe('copy')
    expect(copyItem.icon).toBeTruthy()
    expect(pasteItem.icon).toBeTruthy()
    expect(selectAllItem.icon).toBeTruthy()
    expect(searchIndex).toBeGreaterThan(3)
  })

  it('keeps copy wired to selection state and copySelection()', () => {
    const withoutSelection = createTerminalMenuHarness({ hasSelection: false })
    expect(getTerminalItem(withoutSelection.items, 'terminal-copy').disabled).toBe(true)

    const withSelection = createTerminalMenuHarness({ hasSelection: true })
    const copyItem = getTerminalItem(withSelection.items, 'terminal-copy')

    expect(copyItem.disabled).toBe(false)
    copyItem.onSelect()
    expect(withSelection.terminalActions?.copySelection).toHaveBeenCalledTimes(1)
  })

  it('keeps Paste and Select all wired to terminal action availability', () => {
    const unavailable = createTerminalMenuHarness({ withActions: false })
    expect(getTerminalItem(unavailable.items, 'terminal-paste').disabled).toBe(true)
    expect(getTerminalItem(unavailable.items, 'terminal-select-all').disabled).toBe(true)

    const available = createTerminalMenuHarness()
    const pasteItem = getTerminalItem(available.items, 'terminal-paste')
    const selectAllItem = getTerminalItem(available.items, 'terminal-select-all')

    expect(pasteItem.disabled).toBe(false)
    expect(selectAllItem.disabled).toBe(false)

    pasteItem.onSelect()
    selectAllItem.onSelect()

    expect(available.terminalActions?.paste).toHaveBeenCalledTimes(1)
    expect(available.terminalActions?.selectAll).toHaveBeenCalledTimes(1)
  })
})
```

**Step 2: Add one rendered DOM smoke for the visible terminal menu**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, move `createStoreWithTerminalPane()` out of the nested `describe('Replace pane')` block so it can be reused.

Then add:

```tsx
it('renders copy, Paste, and Select all as the first terminal menu section with icons', async () => {
  const user = userEvent.setup()
  const store = createStoreWithTerminalPane()

  render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
          Terminal Content
        </div>
      </ContextMenuProvider>
    </Provider>
  )

  await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })

  const menu = screen.getByRole('menu')
  const children = Array.from(menu.children)

  expect(
    children.slice(0, 4).map((node) => (
      node.getAttribute('role') === 'menuitem'
        ? node.textContent?.replace(/\s+/g, ' ').trim()
        : node.getAttribute('role')
    )),
  ).toEqual(['copy', 'Paste', 'Select all', 'separator'])

  for (const node of children.slice(0, 3)) {
    expect(node.querySelector('svg')).not.toBeNull()
  }
})
```

Keep all action-wiring assertions in `menu-defs.test.ts`; this test is only the visible DOM smoke.

**Step 3: Run the clipboard tests and confirm they are red**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on ordering, icon presence, and the exact `copy` label.

**Step 4: Implement the minimal menu-definition change**

In `src/components/context-menu/menu-defs.ts`:

- import `createElement` from `react`
- import `Copy`, `ClipboardPaste`, and `TextSelect` from `lucide-react`
- add a small helper for the clipboard trio
- insert that helper at the very top of the terminal menu
- add a separator immediately after that trio
- label `terminal-copy` exactly `copy`
- keep current `Paste`, `Select all`, `Search`, and action wiring semantics intact

Use this helper shape:

```ts
function buildTerminalClipboardItems(terminalActions: TerminalActions | undefined): MenuItem[] {
  const hasSelection = terminalActions?.hasSelection() ?? false

  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: createElement(Copy, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Then insert:

```ts
...buildTerminalClipboardItems(terminalActions),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

immediately before the existing refresh/split/search/scroll/reset items.

**Step 5: Re-run the clipboard tests**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 5: Run The Full Verification Gate

**Files:**
- None

**Step 1: Run the focused regression pack**

Run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

**Step 3: Run the repo typecheck plus test gate**

Run:

```bash
npm run check
```

Expected: PASS.

**Step 4: Run the build-inclusive gate from the worktree**

Run:

```bash
npm run verify
```

Expected: PASS.

### Task 6: Run The Required Browser Spot-Check

**Files:**
- None

**Step 1: Start the worktree server on an isolated port**

Do not use `npm run dev` or `npm run dev:server`; both scripts hardcode `PORT=3002`.

Run:

```bash
PORT=3344 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 npm run dev:client -- --host 127.0.0.1 --port 3345 > /tmp/freshell-3345-client.log 2>&1 & echo $! > /tmp/freshell-3345-client.pid
```

**Step 2: Verify both PIDs belong to this worktree**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
```

Confirm the command paths point at `/home/user/code/freshell/.worktrees/trycycle-pane-context-menu-fix`.

**Step 3: Open `http://127.0.0.1:3345` and confirm the real UX**

Check these exact behaviors:

1. Create or use a split tab with two terminal panes.
2. Right-click the inactive pane header and confirm the pane menu stays open instead of flashing closed.
3. Right-click inside the inactive terminal body and confirm the terminal menu stays open too.
4. In the terminal menu, confirm the first section is `copy`, `Paste`, `Select all`, in that order, with an icon on each item.
5. As a shared-shell sanity check, right-click an inactive browser pane once and confirm its pane menu also stays open.

If browser access is blocked in this environment, record that blocker explicitly in the execution report. Do not silently skip this step.

**Step 4: Stop only those verified worktree processes**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
kill "$(cat /tmp/freshell-3344-server.pid)"
kill "$(cat /tmp/freshell-3345-client.pid)"
rm -f /tmp/freshell-3344-server.pid /tmp/freshell-3345-client.pid
```
