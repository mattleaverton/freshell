# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open on inactive panes, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Do not hard-anchor the bug in either `ContextMenuProvider` or pane activation. There are at least three distinct custom-menu paths here: generic pane shell, terminal pane header/shell, and the real xterm body, and the terminal shell path has behavior outside the provider because `Pane` activates on mouse-down and `TerminalView` refocuses the active xterm on the next animation frame. Rebuild the terminal menu in `menu-defs.ts` with a dedicated clipboard section at the top using Lucide icons via `createElement(...)`, and for the reclose bug add regressions that capture both provider dismiss signals and terminal focus churn so the final fix can land in `ContextMenuProvider.tsx`, `Pane.tsx`, `TerminalView.tsx`, or a minimal combination, depending on what the traces actually prove.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket, persistence, or protocol changes.
- No `docs/index.html` update; this is localized menu polish and a regression fix, not a new user flow.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not constrain the fix to provider-side dismissal or to pane activation ahead of time; choose the smallest fix the failing traces justify on the failing surface.

### Task 1: Rebuild The Terminal Clipboard Section In The Menu Contract

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`

**Step 1: Write the failing tests**

Add terminal-menu contract coverage in `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('puts copy, paste, and select all in the first section with icons', () => {
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

    const copyItem = items[0]
    const pasteItem = items[1]
    const selectAllItem = items[2]
    expect(copyItem.type === 'item' ? copyItem.label : null).toBe('copy')
    expect(copyItem.type === 'item' ? copyItem.icon : null).toBeTruthy()
    expect(pasteItem.type === 'item' ? pasteItem.icon : null).toBeTruthy()
    expect(selectAllItem.type === 'item' ? selectAllItem.icon : null).toBeTruthy()
  })

  it('keeps Search outside the top clipboard section', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    const clipboardSeparatorIndex = items.findIndex((item) => item.id === 'terminal-clipboard-sep')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(clipboardSeparatorIndex).toBe(3)
    expect(searchIndex).toBeGreaterThan(clipboardSeparatorIndex)
  })
})
```

**Step 2: Run the targeted unit test and verify it fails**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts --reporter=dot
```

Expected: FAIL because the terminal menu still starts with `Refresh pane`, `terminal-copy` is labeled `Copy selection`, and the three clipboard items have no `icon`.

**Step 3: Write the minimal production change**

Update `src/components/context-menu/menu-defs.ts`:

```ts
import { createElement } from 'react'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'

const terminalClipboardIconProps = { className: 'h-4 w-4', 'aria-hidden': true }

function buildTerminalClipboardItems(
  terminalActions: ReturnType<MenuActions['getTerminalActions']>,
  hasSelection: boolean,
): MenuItem[] {
  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: createElement(Copy, terminalClipboardIconProps),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, terminalClipboardIconProps),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, terminalClipboardIconProps),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Use that helper at the top of the `target.kind === 'terminal'` branch:

```ts
return [
  ...buildTerminalClipboardItems(terminalActions, hasSelection),
  { type: 'separator', id: 'terminal-clipboard-sep' },
  {
    type: 'item',
    id: 'refresh-pane',
    label: 'Refresh pane',
    onSelect: () => actions.refreshPane(target.tabId, target.paneId),
    disabled: !canRefreshPane,
  },
  { type: 'item', id: 'terminal-split-h', label: 'Split horizontally', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'horizontal') },
  { type: 'item', id: 'terminal-split-v', label: 'Split vertically', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'vertical') },
  { type: 'separator', id: 'terminal-tools-sep' },
  {
    type: 'item',
    id: 'terminal-search',
    label: 'Search',
    onSelect: () => terminalActions?.openSearch(),
    disabled: !terminalActions,
  },
  ...terminalResumeMenuItem,
  { type: 'separator', id: 'terminal-sep' },
  // existing scroll / clear / reset / replace items
]
```

Keep `menu-defs.ts` as `.ts`; do not introduce JSX.

**Step 4: Run the unit test and verify it passes**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts --reporter=dot
```

Expected: PASS, with the new top-section order, exact `copy` label, and truthy `icon` fields locked down.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Characterize The Failing Surface And Fix The Proven Cause

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing regressions**

Keep the provider-dismiss trace in `test/unit/client/components/ContextMenuProvider.test.tsx`, but treat it as instrumentation, not as the answer. It should keep covering the generic inactive pane-shell route so failures tell you whether a provider dismiss callback fired:

```tsx
it('keeps the pane menu open when right-clicking an inactive browser pane shell', async () => {
  const user = userEvent.setup()
  const trace = createDismissTrace()

  try {
    const { container } = renderSplitBrowserPaneLayout()
    const paneShells = container.querySelectorAll('[data-context="pane"]')
    await user.pointer({ target: paneShells[1] as HTMLElement, keys: '[MouseRight]' })

    await waitFor(() => {
      expect(
        screen.queryByRole('menu'),
        `menu closed early; dismiss trace=${JSON.stringify(trace.counts)}`,
      ).toBeInTheDocument()
    })
  } finally {
    trace.restore()
  }
})
```

In `test/e2e/refresh-context-menu-flow.test.tsx`, add the same `createDismissTrace()` helper and reuse the existing terminal pane-shell harness, but mock xterm so the test can also measure focus churn on the inactive terminal pane:

```tsx
const terminalInstances: Array<{ focus: ReturnType<typeof vi.fn> }> = []

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
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
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
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

Then add two integration regressions for the distinct terminal routes:

```tsx
it('keeps the terminal pane-shell menu open when right-clicking an inactive terminal header', async () => {
  const layout: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
  const store = createStore(layout)
  const user = userEvent.setup()
  const trace = createDismissTrace()

  try {
    const { container } = renderFlow(store)
    await waitFor(() => {
      expect(terminalInstances).toHaveLength(2)
    })

    const inactiveHeader = container.querySelector(
      '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
    ) as HTMLElement
    expect(inactiveHeader).not.toBeNull()

    const baselineFocusCalls = terminalInstances[1].focus.mock.calls.length
    await user.pointer({ target: inactiveHeader, keys: '[MouseRight]' })
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(
      screen.queryByRole('menu'),
      `menu closed early; dismiss trace=${JSON.stringify(trace.counts)} focusDelta=${terminalInstances[1].focus.mock.calls.length - baselineFocusCalls}`,
    ).toBeInTheDocument()
  } finally {
    trace.restore()
  }
})

it('keeps the terminal menu open when right-clicking an inactive terminal body', async () => {
  const layout: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
  const store = createStore(layout)
  const user = userEvent.setup()
  const trace = createDismissTrace()

  try {
    const { container } = renderFlow(store)
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="terminal-xterm-container"]')).toHaveLength(2)
    })

    const terminalBody = container.querySelector(
      '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-container"]',
    ) as HTMLElement
    expect(terminalBody).not.toBeNull()

    await user.pointer({ target: terminalBody, keys: '[MouseRight]' })

    await waitFor(() => {
      expect(
        screen.queryByRole('menu'),
        `menu closed early; dismiss trace=${JSON.stringify(trace.counts)}`,
      ).toBeInTheDocument()
    })
  } finally {
    trace.restore()
  }
})
```

The terminal header test is the critical missing regression. Its failure message must expose both provider-dismiss counters and the inactive terminal’s `focusDelta`, so the red phase can tell whether the early close came from provider dismissal, terminal activation/focus churn, or both.

**Step 2: Run the targeted regressions and verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: FAIL on at least one of the three routes. Read the failure message before changing code:

- Non-zero dismiss counters on browser shell or terminal body: a provider dismissal path is firing too early.
- Terminal header/shell failure with `focusDelta > 0` and dismiss counters still zero or secondary: pane activation / terminal refocus is the leading suspect.
- Both signals present: fix the earliest proven cause first, rerun, and only layer a second fix if a red test remains.

If all three tests stay green, stop and manually reproduce in the worktree before any production edit; do not ship a guess.

**Step 3: Write the minimal production fix**

Change only the code the red traces justify:

- If a provider dismiss callback is the first proven cause, patch `src/components/context-menu/ContextMenuProvider.tsx` on that path only.
  Example: if `view` cleanup fires, replace cleanup-only close with explicit view-change comparison:

```tsx
const previousViewRef = useRef(view)

useEffect(() => {
  if (menuState && previousViewRef.current !== view) {
    closeMenu()
  }
  previousViewRef.current = view
}, [view, menuState, closeMenu])
```

  Example: if `blur` fires, re-check focus on the next animation frame before closing instead of masking all early events with a timer:

```tsx
const handleBlur = () => {
  requestAnimationFrame(() => {
    if (!document.hasFocus()) closeMenu()
  })
}
```

- If the terminal header/shell regression shows pane-activation / terminal-focus churn first, patch `src/components/panes/Pane.tsx` before touching `TerminalView.tsx`:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

  Then rerun the terminal shell/body regressions. Only if the shell/header path still closes because `TerminalView` refocuses the xterm after the menu opens should you add a narrower guard in `src/components/TerminalView.tsx` around the active-pane focus effect.

- If both a provider dismiss path and terminal focus churn are still red after the first fix, apply the second smallest fix and rerun.

Do not default to a timestamp guard in `ContextMenuProvider.tsx`, and do not change both provider dismissal and pane activation in the same first patch. Let the traces decide the order.

**Step 4: Run the regression pack and verify it passes**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: PASS for the browser pane shell, inactive terminal header/shell, and inactive terminal body routes.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

### Task 3: Run The Full Verification Gate And Manual Spot-Check

**Files:**
- None

**Step 1: Run the focused regression suite together**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  --reporter=dot
```

Expected: PASS. This is the fast confidence gate before slower repo-wide verification.

**Step 2: Run lint on the touched UI code**

Run:

```bash
npm run lint
```

Expected: PASS with no new JSX a11y or TypeScript lint failures from the menu icon markup or whichever dismissal / activation fix path the traces required.

**Step 3: Run the full required test suite**

Run:

```bash
npm test
```

Expected: PASS for both the client Vitest run and the server Vitest run. Do not proceed to any merge/integration step if this fails.

**Step 4: Manually validate in the worktree on non-default ports**

Do not use `npm run dev` or `npm run dev:server` here; those scripts hardcode `PORT=3002`. Start worktree-only processes explicitly:

```bash
PORT=3344 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=5174 npm run dev:client > /tmp/freshell-5174-client.log 2>&1 & echo $! > /tmp/freshell-5174-client.pid
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
readlink -f "/proc/$(cat /tmp/freshell-3344-server.pid)/cwd"
ps -fp "$(cat /tmp/freshell-5174-client.pid)"
readlink -f "/proc/$(cat /tmp/freshell-5174-client.pid)/cwd"
```

Open `http://127.0.0.1:5174` and verify all of the following:

- Right-clicking an inactive terminal pane header or pane shell leaves the custom menu open.
- Right-clicking inside the actual inactive terminal text area leaves the custom menu open.
- The first section of the terminal menu is `copy`, `Paste`, `Select all`, each with an icon.
- The rest of the terminal menu still exposes refresh, split, search, scroll, clear, reset, and replace actions.

**Step 5: Stop the worktree-only processes cleanly**

Run:

```bash
kill "$(cat /tmp/freshell-5174-client.pid)"
rm -f /tmp/freshell-5174-client.pid
kill "$(cat /tmp/freshell-3344-server.pid)"
rm -f /tmp/freshell-3344-server.pid
```

Expected: both recorded worktree processes exit cleanly, with no broad kill pattern and no impact on the main-branch server that owns this session.
