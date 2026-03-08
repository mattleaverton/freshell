# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix the pane right-click menu so it does not immediately reclose, and make the terminal context menu start with an iconized `copy` / `Paste` / `Select all` section.

**Architecture:** Do not assume a new pane-activation product rule. First reproduce the reported close race through the real path: `Pane` / `PaneContainer` interaction, Redux `activePane`, `TerminalView` autofocus, and `ContextMenuProvider` dismiss listeners. Then fix the concrete open-transaction dismiss race in `ContextMenuProvider` while preserving existing pane semantics unless the characterization test proves a deeper change is required. For the menu reorder, keep the change in `buildMenuItems()` and keep `menu-defs.ts` as a `.ts` module by constructing icon nodes with `createElement(...)` instead of JSX.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, lucide-react, Vitest, Testing Library, xterm.js test mocks

---

## Scope Notes

- The requested label/order/icon change applies only to the terminal context menu.
- Preserve existing terminal item ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- `copy` must be labeled exactly `copy`.
- Keep current enable/disable behavior for copy, paste, select all, search, refresh, split, resume, and maintenance items.
- The bug fix must be proven through the actual `ContextMenuProvider` close path and real `TerminalView` focus behavior, not a local `useState` stand-in.
- Tests for the bug should assert only the user-visible requirement: the menu stays open on right-click. They should not lock in whether right-click changes the active pane unless that becomes unavoidable for the final fix.
- Keep `src/components/context-menu/menu-defs.ts` as `.ts`; do not insert JSX into it.
- No server, WebSocket protocol, persistence, or `docs/index.html` changes are required.

### Task 1: Characterize And Fix The Immediate-Reclose Race

**Why:** The reported failure is an interaction race, not a menu-order issue. The plan needs to prove the bug on the real pane/terminal path before making any behavioral change.

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Create: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Write the failing tests**

Add a deterministic dismiss-listener characterization to `test/unit/client/components/ContextMenuProvider.test.tsx`:

```tsx
import { act } from '@testing-library/react'

it('ignores blur from the opening transaction but still closes on a later blur', async () => {
  const user = userEvent.setup()

  renderWithProvider(
    <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
      Shell Pane
    </div>,
  )

  await user.pointer({ target: screen.getByText('Shell Pane'), keys: '[MouseRight]' })
  expect(await screen.findByRole('menu')).toBeInTheDocument()

  fireEvent(window, new Event('blur'))
  expect(screen.getByRole('menu')).toBeInTheDocument()

  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  fireEvent(window, new Event('blur'))
  expect(screen.queryByRole('menu')).toBeNull()
})
```

Create `test/e2e/pane-context-menu-flow.test.tsx` and reproduce the user-visible bug through the real terminal path. Reuse the same xterm mock shape used in `test/unit/client/components/TerminalView.lifecycle.test.tsx` so `TerminalView` mounts, registers actions, and runs its autofocus effect:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import PaneContainer from '@/components/panes/PaneContainer'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    selectAll = vi.fn()
    focus = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

function PaneContainerFromStore({ tabId }: { tabId: string }) {
  const node = useAppSelector((state) => state.panes.layouts[tabId])
  if (!node) return null
  return <PaneContainer tabId={tabId} node={node} />
}

function createTerminalSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-root',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'terminal',
          createRequestId: 'req-1',
          terminalId: 'term-1',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
      {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'terminal',
          createRequestId: 'req-2',
          terminalId: 'term-2',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
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
        activePane: { 'tab-1': 'pane-1' },
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
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function renderFlow() {
  return render(
    <Provider store={createStore(createTerminalSplitLayout())}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <PaneContainerFromStore tabId="tab-1" />
      </ContextMenuProvider>
    </Provider>,
  )
}

it('keeps the terminal context menu open when right-clicking an inactive terminal pane', async () => {
  const user = userEvent.setup()

  renderFlow()

  const terminalContainers = await screen.findAllByTestId('terminal-xterm-container')
  await user.pointer({ target: terminalContainers[1], keys: '[MouseRight]' })

  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/pane-context-menu-flow.test.tsx
```

Expected: FAIL because `ContextMenuProvider` currently arms its dismiss listeners immediately, so a blur fired during the same open transaction can close the menu before the user can act.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/ContextMenuProvider.tsx` to arm dismiss listeners one animation frame after the menu opens:

```tsx
const dismissListenersArmedRef = useRef(false)
const dismissArmFrameRef = useRef<number | null>(null)

const openMenu = useCallback((state: MenuState) => {
  previousFocusRef.current = document.activeElement as HTMLElement | null
  dismissListenersArmedRef.current = false
  if (dismissArmFrameRef.current !== null) {
    cancelAnimationFrame(dismissArmFrameRef.current)
    dismissArmFrameRef.current = null
  }
  setMenuState(state)
}, [])
```

Inside the `useEffect` that currently starts at the `if (!menuState) return` guard:

```tsx
useEffect(() => {
  if (!menuState) return

  dismissListenersArmedRef.current = false
  dismissArmFrameRef.current = requestAnimationFrame(() => {
    dismissListenersArmedRef.current = true
    dismissArmFrameRef.current = null
  })

  const handlePointerDown = (e: MouseEvent) => {
    if (!dismissListenersArmedRef.current) return
    const target = e.target as Node
    if (menuRef.current && menuRef.current.contains(target)) return
    closeMenu()
  }

  const handleScroll = () => {
    if (!dismissListenersArmedRef.current) return
    closeMenu()
  }

  const handleResize = () => {
    if (!dismissListenersArmedRef.current) return
    closeMenu()
  }

  const handleBlur = () => {
    if (!dismissListenersArmedRef.current) return
    closeMenu()
  }

  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleResize)
  window.addEventListener('blur', handleBlur)

  return () => {
    if (dismissArmFrameRef.current !== null) {
      cancelAnimationFrame(dismissArmFrameRef.current)
      dismissArmFrameRef.current = null
    }
    dismissListenersArmedRef.current = false
    document.removeEventListener('pointerdown', handlePointerDown, true)
    window.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('blur', handleBlur)
  }
}, [menuState, closeMenu])
```

Do not start by changing `Pane.tsx`. If the real characterization still fails after this provider-level guard, inspect which close signal is still firing and narrow the fix there before changing pane activation semantics.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/pane-context-menu-flow.test.tsx
git commit -m "fix(context-menu): prevent immediate dismiss after open"
```

### Task 2: Reorder Terminal Clipboard Actions And Add Icons

**Why:** The user asked for `copy`, `Paste`, and `Select all` to live in their own top section, and for those three items to render icons. This is a pure menu-definition change and should be driven by tests at both the data and rendered-DOM levels.

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Write the failing tests**

Add this unit coverage to `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('puts copy, Paste, and Select all first and separates them from the rest of the menu', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    expect(items.slice(0, 4).map((item) => item.type === 'item' ? item.id : item.type)).toEqual([
      'terminal-copy',
      'terminal-paste',
      'terminal-select-all',
      'separator',
    ])

    const labels = items.slice(0, 3).map((item) => item.type === 'item' ? item.label : '')
    expect(labels).toEqual(['copy', 'Paste', 'Select all'])
  })

  it('attaches icons to the terminal clipboard items', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    for (const id of ['terminal-copy', 'terminal-paste', 'terminal-select-all']) {
      const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
      expect(item?.type).toBe('item')
      if (item?.type === 'item') {
        expect(item.icon).toBeTruthy()
      }
    }
  })

  it('"Search" appears after the split section, not inside the clipboard section', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    const splitSeparatorIndex = items.findIndex((item) => item.type === 'separator' && item.id === 'terminal-split-sep')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(splitSeparatorIndex).toBeGreaterThan(0)
    expect(searchIndex).toBe(splitSeparatorIndex + 1)
  })
})
```

Extend `test/e2e/pane-context-menu-flow.test.tsx` with a rendered-menu assertion:

```tsx
import { within } from '@testing-library/react'

it('renders copy, Paste, and Select all as the first iconized section of the terminal menu', async () => {
  const user = userEvent.setup()

  renderFlow()

  const terminalContainers = await screen.findAllByTestId('terminal-xterm-container')
  await user.pointer({ target: terminalContainers[1], keys: '[MouseRight]' })

  const menu = await screen.findByRole('menu')
  const firstThree = within(menu).getAllByRole('menuitem').slice(0, 3)

  expect(firstThree.map((item) => item.textContent?.trim())).toEqual([
    'copy',
    'Paste',
    'Select all',
  ])

  for (const item of firstThree) {
    expect(item.querySelector('svg')).not.toBeNull()
  }
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: FAIL because the terminal menu still starts with refresh/split items, `terminal-copy` is labeled `Copy selection`, and no icons are attached.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`. Keep the file as `.ts` and use `createElement(...)` for icons:

```ts
import { createElement } from 'react'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'
```

Add a helper near the other menu helpers:

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
      icon: createElement(Copy, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Then reorder the `target.kind === 'terminal'` branch so the first section is:

```ts
...buildTerminalClipboardItems(terminalActions, hasSelection),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

and move `Refresh pane`, split items, and `Search` after that separator. Preserve the existing ids and existing actions for resume, scroll, clear, reset, and replace.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
git commit -m "feat(context-menu): reorder terminal clipboard actions"
```

### Task 3: Regression Sweep And Manual Validation

**Why:** This is a high-visibility interaction path. The focused regression lane should prove the bug fix and menu layout, and the full test suite plus one manual browser pass should catch integration issues before merge.

**Files:**
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Run the focused regression lane**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS. If anything fails, stop and fix it before merge or rebase work.

**Step 3: Start a worktree dev server on a dedicated port**

Run:

```bash
PORT=3344 npm run dev > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Expected: the worktree app is reachable on port `3344`.

**Step 4: Manually verify the behavior**

- Right-click an inactive terminal pane body.
- Confirm the menu stays open instead of flashing closed.
- Repeat on the pane header if that path was previously affected.
- Confirm the first section is `copy`, `Paste`, `Select all`.
- Confirm each of those three rows renders an icon.
- Confirm menu actions still target the clicked pane, not some other pane.

Do not treat active-pane changes on right-click as a required outcome one way or the other unless the final implementation explicitly chooses and tests that behavior.

**Step 5: Stop only that worktree server**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)"
rm -f /tmp/freshell-3344.pid
```

Expected: `ps` shows the process belongs to `.worktrees/trycycle-pane-context-menu-fix`, and only that PID is terminated.
