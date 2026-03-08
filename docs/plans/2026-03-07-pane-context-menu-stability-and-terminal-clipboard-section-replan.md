# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two contracts. First, lock down the terminal clipboard section at the menu-definition layer plus one rendered DOM smoke so order, label, icons, disabled state, and handler wiring are explicit. Second, characterize the menu-close bug through the real `PaneLayout` routes that exist today: pane shell on browser panes, pane shell on terminal panes, and terminal body on terminal panes. Use the smallest production change that turns a reproduced route green, but keep a real-browser worktree spot-check as an explicit verification gate because the suspected interaction spans native `contextmenu`, capture-phase dismissal, pane activation, and terminal refocus timing.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, Vite dev server, xterm.js mocks

---

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is localized menu behavior plus menu-item polish.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- `ContextMenu` already renders `item.icon`, so the clipboard-icon change should stay in `menu-defs.ts` unless a failing rendered test proves otherwise.
- Terminal-body coverage must target a descendant appended inside `data-testid="terminal-xterm-container"` by the test xterm mock. Right-clicking only the wrapper div does not count as terminal-body coverage.
- Automated tests are the primary regression proof, but they are not the only proof. If jsdom stays green while the real browser still flashes the menu closed, follow the browser evidence and refine the automated harness before changing production code.

### Task 1: Lock Down The Terminal Clipboard Section Contract

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Repair the existing `menu-defs` harness and add failing clipboard-section tests**

In `test/unit/client/context-menu/menu-defs.test.ts`, first rename the stale `copyFreshclaude*` mocks inside `createActions()` to the current `copyAgentChat*` method names so the harness matches the real `MenuActions` surface before adding new assertions.

Then add small helpers near `makeCtx(...)` so the terminal menu contract can be asserted directly:

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

Add this failing coverage:

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

Expected red state: the first section still begins with `Refresh pane`, `terminal-copy` is still labeled `Copy selection`, and the clipboard items do not yet carry icons.

**Step 2: Add a failing rendered-DOM smoke for the visible menu**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, move `createStoreWithTerminalPane()` out of the nested `describe('Replace pane')` block so it can support both the existing replace-pane test and the new clipboard rendering smoke.

Then add this test:

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

This DOM smoke should stay presentation-focused. Keep enabled/disabled semantics and handler wiring in `menu-defs.test.ts`.

**Step 3: Run the Task 1 tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on the new ordering, label, icon, and rendered-section assertions.

**Step 4: Implement the minimal menu-definition change**

Update `src/components/context-menu/menu-defs.ts`:

- Keep the file as `.ts`; use `createElement(...)`, not JSX.
- Import `createElement` from `react`.
- Import three Lucide icons that fit the clipboard section, for example `Copy`, `ClipboardPaste`, and `TextSelect`.
- Add a helper so the clipboard items are defined once and inserted at the very top of the terminal menu.
- Label `terminal-copy` exactly `copy`.
- Keep `terminal-search` outside the clipboard section.
- Preserve the existing `copySelection()`, `paste()`, and `selectAll()` wiring plus disabled rules.

The helper should look like this:

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

Insert those items immediately before a dedicated separator such as `terminal-clipboard-sep`, then leave the existing refresh/split/search/scroll/reset sections after that separator.

**Step 5: Re-run the Task 1 tests and verify they pass**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS for the clipboard contract, handler wiring, and rendered DOM smoke.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Reproduce And Fix Pane Context Menu Stability From The Real Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`
- Modify as needed: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify as needed: `src/components/panes/Pane.tsx`
- Modify as needed: `src/components/TerminalView.tsx`

**Step 1: Add a failing route-matrix regression harness**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Reuse the `createStore(...)` / `renderFlow(...)` pattern from `test/e2e/refresh-context-menu-flow.test.tsx`, but build the matrix around the routes that actually exist in the current tree:

- browser pane shell, already-active pane
- browser pane shell, inactive pane
- terminal pane shell, already-active pane
- terminal pane shell, inactive pane
- terminal body, already-active pane
- terminal body, inactive pane

At the top of the file, add a local xterm mock that appends a child surface into the real container so the terminal-body route goes through `term.open(...)` instead of a wrapper shortcut:

```tsx
const terminalInstances: Array<{ focus: ReturnType<typeof vi.fn> }> = []

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
      terminalInstances.push(this)
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

Add the same `MockResizeObserver` pattern used by the existing terminal e2e tests, plus helpers like:

```tsx
function createBrowserSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-browser',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createBrowserLeaf('pane-1', 'browser-1', 'https://example.com/one'),
      createBrowserLeaf('pane-2', 'browser-2', 'https://example.com/two'),
    ],
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

async function rightClickAndExpectMenuToStayOpen(target: HTMLElement) {
  const user = userEvent.setup()
  await user.pointer({ target, keys: '[MouseRight]' })
  await waitForMenuToSettle()
  expect(screen.getByRole('menu')).toBeInTheDocument()
}
```

One terminal-body regression should look like this:

```tsx
it('keeps the terminal body menu open when right-clicking an inactive terminal pane', async () => {
  const store = createStore(createTerminalSplitLayout())
  const { container } = renderFlow(store)

  expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')

  const inactiveSurface = await waitFor(() => {
    const node = container.querySelector(
      '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-surface"]',
    ) as HTMLElement | null
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await rightClickAndExpectMenuToStayOpen(inactiveSurface)
})
```

For pane-shell cases, target the actual pane shell selector:

```tsx
const inactivePaneShell = container.querySelector(
  '[data-context="pane"][data-pane-id="pane-2"]',
) as HTMLElement
```

Do not add assertions about `activePane` changes or `focus()` calls to the final contract. Those are only diagnostic aids if the user-visible menu-open assertion is not yet reproducing the bug.

**Step 2: Run the new stability suite**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: ideally at least one route fails on current code by closing the menu before the post-open settle window ends.

**Step 3: If the suite stays green, reproduce in a real browser from the worktree before touching production code**

If Step 2 does not go red, do not guess the cause from jsdom alone. Start an isolated worktree dev server on unique ports:

```bash
PORT=3344 VITE_PORT=3345 npm run dev:server > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=3345 npm run dev:client -- --host 127.0.0.1 > /tmp/freshell-3345-client.log 2>&1 & echo $! > /tmp/freshell-3345-client.pid
```

Verify both PIDs belong to this worktree before using them:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
```

Then open `http://127.0.0.1:3345` and manually identify which real route still flashes closed:

1. Right-click the default terminal pane shell.
2. If that stays open, split once and try the inactive terminal pane shell.
3. Right-click inside the terminal body itself, not just the pane chrome.

If the browser shows a failing route that Step 2 missed, go back to `test/e2e/pane-context-menu-stability.test.tsx` and sharpen the harness around that exact route before touching production code. Use temporary diagnostics only as needed:

- Record `store.getState().panes.activePane['tab-1']` before and after the right-click to see whether the route activates the pane on secondary click.
- Compare `terminalInstances[index].focus.mock.calls.length` before and after the right-click to see whether terminal refocus is involved.
- Remove those diagnostics once one faithful, user-visible menu-open assertion is red.

Stop only the worktree processes you started:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
kill "$(cat /tmp/freshell-3344-server.pid)"
kill "$(cat /tmp/freshell-3345-client.pid)"
rm -f /tmp/freshell-3344-server.pid /tmp/freshell-3345-client.pid
```

Expected state after this step: there is at least one failing automated regression that matches the real browser route closely enough to justify a production fix.

**Step 4: Implement only the smallest fix justified by the red route**

Start with the narrowest production hook that the failing route actually exercises:

- If pane-shell routes are red, start in `src/components/panes/Pane.tsx`, because the shell-wide focus hook is currently `onMouseDown={onFocus}` on the pane wrapper. The first candidate fix is to ignore non-primary buttons there:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

- If pane-shell routes still fail after that, inspect `src/components/context-menu/ContextMenuProvider.tsx`, especially the capture-phase `pointerdown` close path that runs while the menu is open. Adjust it so the secondary-button interaction that opens the menu does not immediately self-dismiss it.
- If only terminal-body routes are red, inspect `src/components/TerminalView.tsx`, especially the `requestAnimationFrame(() => term.focus())` path for the active pane. Add the smallest guard that stops a context-menu-triggered refocus from stomping the just-opened menu.

Do not land multiple speculative fixes together. Apply one change, rerun the red test, and only widen the fix if the first minimal change does not clear the reproduced route.

**Step 5: Re-run the stability suite and verify it passes**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: PASS for browser pane shell, terminal pane shell, and terminal body on both active and inactive panes.

**Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open"
```

Stage only the production files actually changed.

### Task 3: Run The Full Verification Gate

**Files:**
- None

**Step 1: Run the focused regression pack**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS for the clipboard contract and the pane context-menu stability matrix.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS with no new lint or accessibility issues.

**Step 3: Run the repo TypeScript and test gate**

Run:

```bash
npm run check
```

Expected: PASS for repo typecheck plus the full client/server test suite.

**Step 4: Run the build-inclusive gate from the worktree**

Run:

```bash
npm run verify
```

Expected: PASS for build plus the full test suite. Because this is a worktree, the build output is isolated and safe to generate here.

**Step 5: Run the approved real-browser worktree spot-check**

Start an isolated dev server again on unique ports:

```bash
PORT=3344 VITE_PORT=3345 npm run dev:server > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=3345 npm run dev:client -- --host 127.0.0.1 > /tmp/freshell-3345-client.log 2>&1 & echo $! > /tmp/freshell-3345-client.pid
```

Verify the PIDs belong to this worktree:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
```

Open `http://127.0.0.1:3345` and confirm all of the following in the real browser:

1. Right-click inside a terminal body and confirm the menu stays open.
2. The first terminal menu section is `copy`, `Paste`, `Select all`, in that order, with an icon on each item.
3. Create or use an inactive pane and right-click its pane shell; the menu should not flash open and immediately close.
4. If the failing automated route from Task 2 involved a specific surface beyond those checks, spot-check that exact surface once in the browser too.

Then stop only those verified worktree processes:

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
kill "$(cat /tmp/freshell-3344-server.pid)"
kill "$(cat /tmp/freshell-3345-client.pid)"
rm -f /tmp/freshell-3344-server.pid /tmp/freshell-3345-client.pid
```

Expected: the real browser matches the automated result on the route that was originally failing, and the clipboard section matches the requested UI exactly.
