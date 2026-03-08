# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two contracts. First, lock down the terminal clipboard section at the menu-definition layer plus one rendered DOM smoke so order, label, icons, disabled state, and handler wiring are explicit. Second, add a dedicated high-fidelity pane-context-menu stability harness that exercises the real browser shell, terminal header, and terminal body routes through `PaneLayout`; inactive routes must begin from an inactive pane, but the success contract is only that the menu remains open. If pane activation or terminal refocus must be characterized to localize a failing route, keep that instrumentation diagnostic-only and prove terminal body behavior by right-clicking an injected xterm child surface, not the wrapper div.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test doubles

---

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is localized menu behavior plus menu-item polish.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- The product contract is user-visible: the menu stays open, and the clipboard section order/label/icon/wiring is correct. `activePane` changes and `term.focus()` calls are implementation details unless a failing test proves they are part of the minimal fix.
- Any stability regression for terminal body must target a descendant appended inside `data-testid="terminal-xterm-container"` by the test xterm mock. Wrapper-only right-clicks do not count as terminal-body coverage.
- Do not rely on a manual worktree dev server in this plan. The automated route matrix must be strong enough to verify the bug without unsafe port assumptions.

### Task 1: Lock Down The Terminal Clipboard Section Contract

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing menu-definition tests**

In `test/unit/client/context-menu/menu-defs.test.ts`, add small helpers before the new assertions so the tests can inspect terminal items directly:

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

Then add the clipboard-section coverage:

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

Expected red state: terminal clipboard actions are still below refresh/split items, `terminal-copy` is still labeled `Copy selection`, and the items do not yet render icons.

**Step 2: Write the failing rendered-DOM smoke**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, move `createStoreWithTerminalPane()` out of the nested `describe('Replace pane')` block so it can serve multiple terminal-menu tests.

Then add a rendered regression that verifies the visible terminal menu matches the clipboard contract:

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

Keep this DOM test focused on rendered order and icon presence. The wiring and disabled-state semantics stay in `menu-defs.test.ts`.

**Step 3: Run the targeted Task 1 tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on the new ordering, label, icon, and behavior assertions.

**Step 4: Write the minimal production change**

Update `src/components/context-menu/menu-defs.ts`:

- Keep the file as `.ts`; use `createElement(...)`, not JSX.
- Import `createElement` from `react`.
- Import three Lucide icons that fit the new clipboard section, for example `Copy`, `ClipboardPaste`, and `TextSelect`.
- Add a small helper so the clipboard items are defined once and inserted at the top of the terminal menu.
- Label `terminal-copy` exactly `copy`.
- Keep `terminal-search` outside the new top section.
- Preserve the existing `copySelection()`, `paste()`, and `selectAll()` wiring and disabled rules.

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

Insert those three items immediately before a dedicated separator such as `terminal-clipboard-sep`.

**Step 5: Re-run the targeted Task 1 tests and verify they pass**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS for the clipboard contract, handler wiring, disabled-state assertions, and provider-rendered DOM smoke.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Add A High-Fidelity Pane Context Menu Stability Regression And Fix Only The Proven Cause

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`
- Modify as needed: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify as needed: `src/components/panes/Pane.tsx`
- Modify as needed: `src/components/TerminalView.tsx`

**Step 1: Create the failing route-matrix harness**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Reuse the store/layout pattern from `test/e2e/refresh-context-menu-flow.test.tsx`, but give this file its own xterm mock so terminal body routes are exercised against a child surface that `term.open(...)` injected.

At the top of the file, add the minimal terminal doubles:

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

Add the same `MockResizeObserver` / store / `renderFlow()` helpers that the existing e2e context-menu file uses, plus:

```tsx
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

Then add six user-visible regressions:

- Browser pane shell, already-active pane: right-click `[data-context="pane"][data-pane-id="pane-1"]`.
- Browser pane shell, inactive pane: start with `activePane['tab-1'] === 'pane-1'`, then right-click `[data-context="pane"][data-pane-id="pane-2"]`.
- Terminal header, already-active pane: right-click `[data-context="pane"][data-pane-id="pane-1"] [role="banner"]`.
- Terminal header, inactive pane: start with `pane-1` active, then right-click `[data-context="pane"][data-pane-id="pane-2"] [role="banner"]`.
- Terminal body, already-active pane: wait for `[data-testid="terminal-xterm-surface"]` inside `pane-1`, then right-click that surface.
- Terminal body, inactive pane: same surface selector inside `pane-2`.

One of the terminal-body tests should look like this:

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

Important: do not turn `activePane` changes or `focus()` calls into pass/fail requirements here. Those are optional diagnostics, not the contract.

**Step 2: Run the new stability suite and verify it fails**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: at least one high-fidelity route fails on current code by closing the menu immediately or before the post-open settle window ends.

**Step 3: If every route is green, add route-local diagnostics before touching production code**

If Step 2 does not reproduce the bug, stay in `test/e2e/pane-context-menu-stability.test.tsx` and sharpen the exact failing route inside that same harness:

- For inactive routes, record the pre/post `store.getState().panes.activePane['tab-1']` value to learn whether the route still activates panes on right-click.
- For terminal routes, use `terminalInstances[index].focus.mock.calls.length` before and after the right-click to learn whether terminal refocus is part of the close.
- Keep those assertions diagnostic-only while identifying the failing path. Do not commit permanent tests that require activation or refocus unless the final user-visible behavior depends on them.
- Do not fall back to right-clicking `data-testid="terminal-xterm-container"`; if terminal body is the real route, keep targeting the injected surface.

Re-run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: FAIL on one faithful route with enough evidence to choose the smallest production fix.

**Step 4: Write the minimal production fix justified by the red test**

Pick the smallest code path the failing route actually proves:

- If the menu is being dismissed by provider-level event handling, fix `src/components/context-menu/ContextMenuProvider.tsx` and leave pane/terminal behavior alone.
- If secondary-button activation on the pane shell is what closes the menu, change `src/components/panes/Pane.tsx` so left-click activation still works but the right-click route no longer self-dismisses the menu.
- If terminal refocus during menu open is what closes the menu, add the smallest guard in `src/components/TerminalView.tsx` that prevents refocus from stomping the open menu without changing unrelated focus behavior.

Do not preserve any current mechanism just because it exists. The only required steady-state behavior is that the menu stays open on the reproduced route.

**Step 5: Re-run the stability suite and verify it passes**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: PASS for browser shell, terminal header, and terminal body on both active and inactive panes.

**Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

Stage only the production files actually changed.

### Task 3: Run The Verification Gate

**Files:**
- None

**Step 1: Run the focused client regression pack**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS for the clipboard contract and the pane context-menu stability route matrix.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS with no new lint or accessibility issues.

**Step 3: Run the full required test suite**

Run:

```bash
npm test
```

Expected: PASS for the full client and server suite. If anything fails, stop and fix it before merge, even if it appears unrelated.
