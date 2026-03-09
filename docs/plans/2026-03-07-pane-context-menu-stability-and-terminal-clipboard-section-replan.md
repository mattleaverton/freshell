# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two contracts. First, lock down the terminal clipboard section in `menu-defs.ts` with unit coverage plus one rendered DOM smoke so order, label, icons, disabled state, and handler wiring are explicit. Second, reproduce the reclose bug on the concrete inactive-pane routes users hit today, then fix the narrow seam those red tests identify. The most likely seam is `Pane`'s unconditional secondary-button activation, but that is only a valid fix if a reproduced route points there. Finish with one real browser spot-check using corrected worktree startup commands, because the accepted medium strategy included an interactive validation checkpoint.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, Vite dev server, xterm.js mocks

---

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is localized menu behavior plus menu-item polish.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- `ContextMenu` already renders `item.icon`, so the clipboard-icon change should stay in `menu-defs.ts` unless a failing rendered test proves otherwise.
- Terminal-body coverage must target a descendant appended inside `data-testid="terminal-xterm-container"` by the test xterm mock. Right-clicking only the wrapper div does not count as terminal-body coverage.
- Automated tests are still the primary regression proof, but they are not the whole contract here. The final execution report must also include one live browser spot-check or an explicit statement that the environment blocked it.

## Strategy Notes

- Do not start by changing `ContextMenuProvider`'s capture-phase `pointerdown` dismissal. That listener is installed only after `menuState` exists, so it cannot observe the secondary click that opened the menu.
- Do not encode invented product rules. If you add a seam-level contract such as "secondary mouse down does not focus an inactive pane", tie it to a reproduced user-visible failure and keep the justification in the test names and plan notes.
- Use the existing `refresh-context-menu-flow` harness shape and the real `Pane` / `PaneLayout` / `TerminalView` routes. Do not introduce a fake seam when the repo already has a close analog.
- For manual validation, do not use `npm run dev:server` with a custom `PORT`; that script hardcodes `3002`.

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

### Task 2: Reproduce And Fix Pane Context Menu Stability From The Real Inactive-Pane Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`
- Modify: `test/unit/client/components/panes/Pane.test.tsx`
- Modify as needed: `src/components/panes/Pane.tsx`
- Modify as needed: `src/components/TerminalView.tsx`
- Modify as needed: `src/components/context-menu/ContextMenuProvider.tsx`

**Step 1: Add focused failing regressions for the actual user-facing routes**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Reuse the `createStore(...)` / `renderFlow(...)` pattern from `test/e2e/refresh-context-menu-flow.test.tsx`, but target only the concrete routes that can explain the reported "sometimes recloses immediately" behavior:

- browser pane shell, inactive pane
- terminal pane shell, inactive pane
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

The terminal-body regression should look like this:

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

Add three route tests:

- `browser pane shell stays open when right-clicking an inactive pane`
- `terminal pane shell stays open when right-clicking an inactive pane`
- `terminal body stays open when right-clicking an inactive pane`

Do not add `activePane` or `focus()` assertions to the final contract in this file. Those are diagnostics only if one of the user-visible routes does not reproduce cleanly.

**Step 2: Run the new stability suite**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: ideally at least one route fails on current code by closing the menu before the post-open settle window ends.

**Step 3: If the suite goes red, prove the narrow seam before changing production code**

If Step 2 fails on an inactive pane-shell or terminal-body route, first verify whether the failure depends on secondary-click pane activation through the shared shell. Add this focused unit regression to `test/unit/client/components/panes/Pane.test.tsx`:

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

Keep the existing primary-button focus test. This seam-level test is justified only because the route-level failure has already shown that secondary-click activation is part of the bug.

**Step 4: If the suite stays green, tighten the automated repro before touching production code**

If Step 2 does not go red, do not guess and do not switch to a mandatory manual browser step. Stay inside `test/e2e/pane-context-menu-stability.test.tsx` and, if needed, `test/unit/client/components/ContextMenuProvider.test.tsx`, and make the automated harness more faithful to the current code paths:

- Keep each inactive-pane case honest: assert `store.getState().panes.activePane['tab-1'] === 'pane-1'` before the right-click and target `pane-2`.
- Add temporary diagnostics around the most likely failing route only:
  - Record `store.getState().panes.activePane['tab-1']` before and after the right-click to see whether the route activates the pane on secondary click.
  - Compare `terminalInstances[index].focus.mock.calls.length` before and after the right-click to see whether terminal refocus is involved.
  - If needed, extend `waitForMenuToSettle()` by one more animation frame or add a `waitFor(...)` around disappearance so the test can observe a flash-close, not just the final steady state.
- If the top-level route matrix still stays green, add one narrower characterization test at the actual suspected seam before touching production code:
  - `src/components/panes/Pane.tsx`: whether non-primary `onMouseDown` on an inactive pane triggers activation.
  - `src/components/context-menu/ContextMenuProvider.tsx`: whether a later post-open `pointerdown` is what closes the menu immediately after open.
  - `src/components/TerminalView.tsx`: whether the active-pane `requestAnimationFrame(() => term.focus())` runs immediately after a terminal-body context-menu open.
- Remove the temporary diagnostics once one faithful, user-visible menu-open assertion is red.

If you exhaust these automated refinements and still cannot make a real route fail under test, stop and report a blocker instead of applying speculative production fixes.

Expected state after this step: there is at least one failing automated regression tied to a concrete repo seam, and the plan never requires browser access to keep moving.

**Step 5: Implement only the smallest fix justified by the red route**

Start with the narrowest production hook that the failing route actually exercises:

- If the red route plus the seam-level `Pane.test.tsx` regression show secondary-click activation through the shared shell, start in `src/components/panes/Pane.tsx`, because the shell-wide focus hook is currently `onMouseDown={onFocus}` on the pane wrapper. The first candidate fix is to ignore non-primary buttons there:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

- If pane-shell routes still fail after that, inspect `src/components/context-menu/ContextMenuProvider.tsx`, but only for behavior that happens after `menuState` exists. Do not blame the opening secondary click on the post-open `pointerdown` listener without a new failing test that proves it.
- If the shell fix clears shell routes but the terminal-body route still fails, inspect `src/components/TerminalView.tsx`, especially the `requestAnimationFrame(() => term.focus())` path for the active pane. Add the smallest guard that stops a context-menu-triggered refocus from stomping the just-opened menu, and back that change with the smallest additional regression necessary.

Do not land multiple speculative fixes together. Apply one change, rerun the red test, and only widen the fix if the first minimal change does not clear the reproduced route.

**Step 6: Re-run the stability suite and verify it passes**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Then run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS for the inactive browser shell, inactive terminal shell, and inactive terminal body routes, plus the seam-level `Pane` regression if it was added.

**Step 7: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/pane-context-menu-stability.test.tsx test/unit/client/components/panes/Pane.test.tsx
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
  test/unit/client/components/panes/Pane.test.tsx \
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

### Task 4: Run The Required Browser Spot-Check

**Files:**
- None

**Step 1: Start the worktree app on isolated ports**

Do not use `npm run dev:server` for a custom backend port here; `package.json` hardcodes `PORT=3002` in that script. Start the worktree app on isolated ports with commands that actually honor `PORT` and `VITE_PORT`:

```bash
PORT=3344 VITE_PORT=3345 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=3345 npm run dev:client -- --host 127.0.0.1 > /tmp/freshell-3345-client.log 2>&1 & echo $! > /tmp/freshell-3345-client.pid
```

**Step 2: Verify the PIDs belong to this worktree before using them**

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
```

**Step 3: Open `http://127.0.0.1:3345` and confirm the actual UX**

1. Right-click inside a terminal body and confirm the menu stays open.
2. Create or use an inactive terminal pane and right-click its pane header or shell; the menu should not flash open and immediately close.
3. The first terminal menu section is `copy`, `Paste`, `Select all`, in that order, with an icon on each item.
4. If you have a browser pane available, right-click its inactive pane shell once as a quick sanity check that the shared shell route also stays open.

If browser access in this environment is impossible, do not silently skip this task. Record that the browser spot-check was blocked and why.

**Step 4: Stop only those verified worktree processes when finished**

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
kill "$(cat /tmp/freshell-3344-server.pid)"
kill "$(cat /tmp/freshell-3345-client.pid)"
rm -f /tmp/freshell-3344-server.pid /tmp/freshell-3345-client.pid
```
