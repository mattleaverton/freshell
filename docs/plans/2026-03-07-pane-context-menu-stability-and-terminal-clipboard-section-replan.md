# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open long enough to use, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as one behavioral fix and one structural menu change. For menu stability, prove the bug on real rendered terminal-pane routes, then suppress only the active-terminal autofocus that collides with context-menu opening by marking the pane shell during secondary-button/context-menu interactions and honoring that marker in `TerminalView`'s active-pane focus effect. For the clipboard reordering, keep the change inside `src/components/context-menu/menu-defs.ts` and verify both the menu-definition data and the rendered DOM.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, Vite, xterm.js mocks

---

## Strategy Gate

- Solve the user’s request directly: the menu must stay open long enough to use, and terminal clipboard actions must move to their own top section with icons.
- Do **not** encode a new product rule that “right-click never activates a pane.” The contract is narrower: right-click opening the menu must not steal terminal focus in the same interaction window or reclose the menu.
- Preserve normal primary-click behavior. The fix should keep ordinary inactive-pane activation and terminal autofocus working on left click.
- Use the two real terminal-pane entry points that matter:
  - inactive terminal pane header -> pane menu
  - inactive terminal body -> terminal menu
- Make the red signal deterministic. Each stability regression must assert both:
  - the menu remains open after the interaction settles
  - the inactive terminal’s `focus()` spy does not fire during that right-click path
- Keep browser-pane coverage out of the automated mainline. One browser-pane sanity check belongs in the required browser spot-check only.
- The accepted medium strategy requires one real browser validation pass after automated tests. That is mandatory.

## Diagnostic Carry-Forward

- Diagnostic feedback for the implementer: prior loops kept drifting by turning conjectures into requirements. Do not add new framing while executing this plan; let failing tests drive the fix.
- Do not start in `ContextMenuProvider`. Its dismissal listeners are not the first justified seam here, and previous loops overfit to that theory.
- If the pane-shell marker plus the active-pane autofocus guard clears both right-click routes while preserving left-click autofocus, stop there.
- Only widen beyond the active-pane autofocus effect if a still-red regression proves another `term.focus()` path participates in the same close sequence.

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is a localized UI behavior fix, not a new feature surface.
- Preserve existing menu item ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Keep `ContextMenu` as the renderer. The icon change belongs in menu item definitions, not in a renderer rewrite.
- Preserve existing `Paste`, `Select all`, and `Search` labels. Only `copy` changes text.
- The terminal-body regression must right-click a descendant created inside `data-testid="terminal-xterm-container"`. Right-clicking only the wrapper is not sufficient body coverage.

### Task 1: Reproduce The Stability Contract On Real Terminal-Pane Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Create the dedicated rendered harness**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Reuse the `createStore(...)` and `renderFlow(...)` shape from `test/e2e/refresh-context-menu-flow.test.tsx`, but add a terminal mock that gives you both a real DOM surface and access to each terminal instance’s `focus()` spy:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import PaneLayout from '@/components/panes/PaneLayout'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import type { PaneNode } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => vi.fn()),
  onReconnect: vi.fn(() => vi.fn()),
  setHelloExtensionProvider: vi.fn(),
}))

const terminalInstances = vi.hoisted(() => [] as Array<{
  focus: ReturnType<typeof vi.fn>
  openedSurface: HTMLElement | null
}>)

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    openedSurface: HTMLElement | null = null
    focus = vi.fn()

    constructor() {
      terminalInstances.push(this)
    }

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
    reset = vi.fn()
    selectAll = vi.fn()
    scrollLines = vi.fn()
    scrollToBottom = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    paste = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn(() => {
      this.openedSurface?.remove()
      this.openedSurface = null
    })
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}
```

Add the same `createTerminalLeaf(...)`, `createStore(...)`, and `renderFlow(...)` patterns used in `test/e2e/refresh-context-menu-flow.test.tsx`, but with a split layout containing two terminal panes:

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

function createStore(layout: PaneNode) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': layout.type === 'leaf' ? layout.id : layout.children[0].id },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: 'linux',
        availableClis: {},
        featureFlags: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function renderFlow(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'browser', url: '', devToolsOpen: false }}
        />
      </ContextMenuProvider>
    </Provider>,
  )
}
```

Add these helpers:

```tsx
function getInactiveTerminalInstance() {
  expect(terminalInstances).toHaveLength(2)
  return terminalInstances[1]!
}

async function waitForMenuToSettle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
```

Initialize and reset state with:

```tsx
beforeEach(() => {
  terminalInstances.length = 0
  wsMocks.send.mockClear()
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
```

**Step 2: Add the two right-click regressions plus a left-click control**

In that same file, add these tests:

```tsx
it('keeps the pane menu open and avoids terminal autofocus when right-clicking an inactive pane header', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const inactiveTerminal = await waitFor(() => {
    const instance = getInactiveTerminalInstance()
    expect(instance.openedSurface).not.toBeNull()
    return instance
  })
  const focusCallsBefore = inactiveTerminal.focus.mock.calls.length

  const inactiveHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
  ) as HTMLElement | null
  expect(inactiveHeader).not.toBeNull()

  await user.pointer({ target: inactiveHeader as HTMLElement, keys: '[MouseRight]' })
  await waitForMenuToSettle()

  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(inactiveTerminal.focus).toHaveBeenCalledTimes(focusCallsBefore)
})

it('keeps the terminal menu open and avoids terminal autofocus when right-clicking inside an inactive terminal body', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const inactiveTerminal = await waitFor(() => {
    const instance = getInactiveTerminalInstance()
    expect(instance.openedSurface).not.toBeNull()
    return instance
  })
  const focusCallsBefore = inactiveTerminal.focus.mock.calls.length

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
  expect(inactiveTerminal.focus).toHaveBeenCalledTimes(focusCallsBefore)
})

it('still autofocuses the inactive terminal after a primary-click activation', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const inactiveTerminal = await waitFor(() => {
    const instance = getInactiveTerminalInstance()
    expect(instance.openedSurface).not.toBeNull()
    return instance
  })
  const focusCallsBefore = inactiveTerminal.focus.mock.calls.length

  const inactiveHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
  ) as HTMLElement | null
  expect(inactiveHeader).not.toBeNull()

  await user.pointer({ target: inactiveHeader as HTMLElement, keys: '[MouseLeft]' })

  await waitFor(() => {
    expect(inactiveTerminal.focus.mock.calls.length).toBeGreaterThan(focusCallsBefore)
  })
})
```

These three tests define the contract: right-click routes must not close the menu or steal focus, while ordinary left-click activation must still autofocus the terminal.

**Step 3: Run the stability file before changing production code**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected:
- the left-click control passes
- at least one right-click regression fails today, either because the menu disappears or because the inactive terminal’s `focus()` spy increments during the right-click flow

Do not change production code until the file is red.

### Task 2: Fix Only The Autofocus That Collides With Context-Menu Opening

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/TerminalView.tsx`
- Re-run: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Mark the pane shell during context-menu opening without changing focus semantics**

In `src/components/panes/Pane.tsx`, import `useCallback`, `useEffect`, and `useRef` from `react`, then add a short-lived pane-shell marker:

```tsx
import { useCallback, useEffect, useRef } from 'react'
```

Add these refs and helpers near the top of the component:

```tsx
const shellRef = useRef<HTMLDivElement | null>(null)
const clearContextMenuMarkerRef = useRef<number | null>(null)

const clearContextMenuOpening = useCallback(() => {
  const shell = shellRef.current
  if (shell) {
    delete shell.dataset.contextMenuOpening
  }
  if (clearContextMenuMarkerRef.current !== null) {
    cancelAnimationFrame(clearContextMenuMarkerRef.current)
    clearContextMenuMarkerRef.current = null
  }
}, [])

const markContextMenuOpening = useCallback(() => {
  const shell = shellRef.current
  if (!shell || typeof window === 'undefined') return

  shell.dataset.contextMenuOpening = 'true'

  if (clearContextMenuMarkerRef.current !== null) {
    cancelAnimationFrame(clearContextMenuMarkerRef.current)
  }

  clearContextMenuMarkerRef.current = requestAnimationFrame(() => {
    clearContextMenuMarkerRef.current = requestAnimationFrame(() => {
      if (shellRef.current === shell) {
        delete shell.dataset.contextMenuOpening
      }
      clearContextMenuMarkerRef.current = null
    })
  })
}, [])

useEffect(() => clearContextMenuOpening, [clearContextMenuOpening])
```

Attach that marker to the root pane shell without removing the existing `onMouseDown={onFocus}`:

```tsx
<div
  ref={shellRef}
  data-pane-shell="true"
  data-context={ContextIds.Pane}
  data-tab-id={tabId}
  data-pane-id={paneId}
  ...
  onMouseDownCapture={(event) => {
    if (event.button === 2) {
      markContextMenuOpening()
    }
  }}
  onContextMenuCapture={markContextMenuOpening}
  onMouseDown={onFocus}
  ...
>
```

This is the key architectural decision: preserve current pane activation wiring, but mark that this activation came from a context-menu interaction.

**Step 2: Honor that marker in the active-pane autofocus effect**

In `src/components/TerminalView.tsx`, add a small helper near the existing `shouldFocusActiveTerminal` logic:

```tsx
function isPaneShellOpeningContextMenu(node: HTMLDivElement | null): boolean {
  return node?.closest<HTMLElement>('[data-pane-shell="true"]')?.dataset.contextMenuOpening === 'true'
}
```

Then guard the existing active-terminal autofocus effect:

```tsx
useEffect(() => {
  if (!isTerminal) return
  if (!shouldFocusActiveTerminal) return
  const term = termRef.current
  if (!term) return

  requestAnimationFrame(() => {
    if (termRef.current !== term) return
    if (isPaneShellOpeningContextMenu(containerRef.current)) return
    term.focus()
  })
}, [isTerminal, shouldFocusActiveTerminal])
```

Do not edit unrelated `term.focus()` sites. This plan is specifically targeting the active-pane autofocus effect that fires when an inactive pane becomes active during the right-click path.

**Step 3: Re-run the stability regressions**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: all three tests pass.

If either right-click regression is still red, inspect the failing route and only then widen the focus suppression to another proven `term.focus()` path. Do not jump to provider dismissal changes first.

**Step 4: Commit the stability fix**

```bash
git add src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

### Task 3: Move Terminal Clipboard Actions Into Their Own Top Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Extend the authoritative menu-definition test harness**

In `test/unit/client/context-menu/menu-defs.test.ts`, keep using this file as the authoritative `buildMenuItems(...)` harness.

First, rename the stale `copyFreshclaude*` mocks in `createActions()` to the current `copyAgentChat*` names so the helper matches `MenuActions`:

```ts
copyAgentChatCodeBlock: vi.fn(),
copyAgentChatToolInput: vi.fn(),
copyAgentChatToolOutput: vi.fn(),
copyAgentChatDiffNew: vi.fn(),
copyAgentChatDiffOld: vi.fn(),
copyAgentChatFilePath: vi.fn(),
```

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

Keep action wiring assertions in `test/unit/client/context-menu/menu-defs.test.ts`; this DOM test is only the visible smoke for order, label, and icons.

**Step 3: Run the clipboard tests before changing production code**

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
- add a helper for the clipboard trio
- insert that helper at the very top of the terminal menu
- add a separator immediately after that trio
- label `terminal-copy` exactly `copy`
- keep current `Paste`, `Select all`, `Search`, and action wiring semantics intact

Use this helper:

```ts
function buildTerminalClipboardItems(
  terminalActions: TerminalActions | undefined,
  hasSelection: boolean,
): MenuItem[] {
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

Then, in the `target.kind === 'terminal'` branch, replace the inline clipboard trio with:

```ts
...buildTerminalClipboardItems(terminalActions, hasSelection),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

Put that block immediately before the existing `refresh-pane` / split / `Search` / scroll / reset items.

**Step 5: Re-run the clipboard tests**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 6: Commit the clipboard menu change**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 4: Run The Automated Verification Gate

**Files:**
- None

**Step 1: Run the focused regression pack**

Run:

```bash
npx vitest run \
  test/e2e/pane-context-menu-stability.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 2: Run the existing terminal paste regression**

Run:

```bash
npx vitest run \
  test/unit/client/components/TerminalView.keyboard.test.tsx \
  -t "context-menu paste uses term.paste and emits exactly one terminal.input via onData" \
  --reporter=dot
```

Expected: PASS.

**Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

**Step 4: Run the repo typecheck plus test gate**

Run:

```bash
npm run check
```

Expected: PASS.

**Step 5: Run the build-inclusive gate from the worktree**

Run:

```bash
npm run verify
```

Expected: PASS.

### Task 5: Run The Required Browser Spot-Check

**Files:**
- None

**Step 1: Start the worktree server on isolated ports**

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
2. Right-click the inactive terminal pane header and confirm the menu stays open instead of flashing closed.
3. Right-click inside the inactive terminal body and confirm the menu stays open there too.
4. In the terminal menu, confirm the first section is `copy`, `Paste`, `Select all`, in that order, with an icon on each item.
5. Left-click the inactive terminal pane once and confirm it still becomes the active typing target.
6. As a shared-shell sanity check, right-click an inactive browser pane once and confirm its pane menu also stays open.

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
