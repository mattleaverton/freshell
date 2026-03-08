# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Split the work into two independent contracts. Use `test/unit/client/context-menu/menu-defs.test.ts` to lock down both the layout and behavior of the terminal clipboard items, and use `test/unit/client/components/ContextMenuProvider.test.tsx` plus `test/e2e/refresh-context-menu-flow.test.tsx` to prove the real pane route stays open while inactive panes actually become active. If an inactive terminal route is the failing surface, extend `test/unit/client/components/TerminalView.lifecycle.test.tsx` so the red test proves the full `Pane.onMouseDown -> setActivePane -> TerminalView requestAnimationFrame(...term.focus())` chain ran before the menu is expected to remain open.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is menu polish plus a localized interaction fix.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not change pane-activation semantics unless a red test proves the current secondary-click activation path is the cause of the close.
- The stability work is not done until an automated test has proven the inactive-path activation happened, and if the failing route is terminal-specific, the automated red test must also prove `term.focus()` was scheduled on that path before the production fix lands.
- Do not invent a new terminal harness. If terminal-focus evidence is required, extend `test/unit/client/components/TerminalView.lifecycle.test.tsx`, which already owns the repo's xterm mocks and RAF control.

### Task 1: Lock Down The Terminal Clipboard Section Contract

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing menu-contract tests**

In `test/unit/client/context-menu/menu-defs.test.ts`, add small helpers ahead of the new assertions so the tests can inspect item behavior directly:

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

  return { items, actions, terminalActions }
}
```

Then add the failing clipboard-section coverage:

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

    const available = createTerminalMenuHarness({ hasSelection: false })
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

Expected red state: the clipboard items are not at the top, `copy` still has the old label, the items have no icons, and the new behavior assertions will fail until the section is rebuilt without breaking existing handlers/disabled rules.

**Step 2: Write the failing rendered-DOM regression**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, extract the nested `createStoreWithTerminalPane()` helper from the `Replace pane` block to file scope so it can be reused by multiple terminal-menu tests.

Then add a rendered regression that verifies the visible terminal menu still matches the contract when opened through the real provider:

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

Keep this DOM test focused on order/icon rendering. The behavior semantics are already covered in `menu-defs.test.ts`, which can call the item handlers directly.

**Step 3: Run the targeted Task 1 tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on the new clipboard ordering/label/icon assertions and at least one of the new behavior assertions.

**Step 4: Write the minimal production change**

Update `src/components/context-menu/menu-defs.ts`:

- Keep the file as `.ts`; use `createElement(...)`, not JSX.
- Import `createElement` from `react`.
- Import three Lucide icons that match the new clipboard section, for example `Copy`, `ClipboardPaste`, and `TextSelect`.
- Add a small `buildTerminalClipboardItems(terminalActions)` helper that returns:
  - `terminal-copy` labeled exactly `copy`, iconized, and disabled unless `terminalActions` exists and `terminalActions.hasSelection()` is true
  - `terminal-paste` labeled `Paste`, iconized, and disabled when `terminalActions` is missing
  - `terminal-select-all` labeled `Select all`, iconized, and disabled when `terminalActions` is missing
- Insert that helper at the top of the terminal menu, followed by a dedicated separator such as `terminal-clipboard-sep`.
- Keep `terminal-search` outside the top clipboard section.
- Preserve the existing `onSelect` wiring for `copySelection()`, `paste()`, and `selectAll()`.

The new section should look structurally like this:

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

**Step 5: Re-run the targeted Task 1 tests and verify they pass**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS for the clipboard contract, the handler/disabled-state assertions, and the provider-rendered DOM check.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Prove The Inactive-Pane Close Path And Fix Only The Proven Cause

**Files:**
- Modify as needed: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify as needed: `src/components/panes/Pane.tsx`
- Modify as needed: `src/components/TerminalView.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify only if an inactive terminal route is the failing path: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Add the user-visible route matrix and require inactive routes to prove activation happened**

In `test/e2e/refresh-context-menu-flow.test.tsx`, add the small helpers you need beside the existing layout helpers:

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

async function waitForTwoPaints() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

async function expectMenuToStayOpen(
  store: ReturnType<typeof createStore>,
  target: HTMLElement,
  expectedActivePaneId?: string,
) {
  const user = userEvent.setup()
  await user.pointer({ target, keys: '[MouseRight]' })

  if (expectedActivePaneId) {
    await waitFor(() => {
      expect(store.getState().panes.activePane['tab-1']).toBe(expectedActivePaneId)
    })
  }

  await waitForTwoPaints()
  expect(screen.getByRole('menu')).toBeInTheDocument()
}
```

Add the six route regressions:

- Browser pane shell, already-active pane: target `[data-context="pane"][data-pane-id="pane-1"]`, no activation assertion needed.
- Browser pane shell, inactive pane: target `[data-context="pane"][data-pane-id="pane-2"]`, require `activePane['tab-1'] === 'pane-2'` before checking the menu.
- Terminal header/shell, already-active pane: target `[data-context="pane"][data-pane-id="pane-1"] [role="banner"]`.
- Terminal header/shell, inactive pane: target `[data-context="pane"][data-pane-id="pane-2"] [role="banner"]`, require `activePane['tab-1'] === 'pane-2'`.
- Terminal body, already-active pane: wait for two `[data-testid="terminal-xterm-container"]` nodes, then target `[data-context="terminal"][data-pane-id="pane-1"] [data-testid="terminal-xterm-container"]`.
- Terminal body, inactive pane: same selector for `pane-2`, require `activePane['tab-1'] === 'pane-2'`.

One of the inactive tests should read like this:

```tsx
it('keeps the terminal header menu open while activating an inactive pane', async () => {
  const store = createStore(createTerminalSplitLayout())
  const { container } = renderFlow(store)

  const inactiveHeader = await waitFor(() => {
    const node = container.querySelector(
      '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
    ) as HTMLElement | null
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await expectMenuToStayOpen(store, inactiveHeader, 'pane-2')
})
```

This step fixes the first review gap directly: an inactive-route test is no longer allowed to go green unless the right-click actually drove the `Pane -> setActivePane(...)` path.

**Step 2: Add a unit-speed control that uses the real pane activation path, not `onFocus={() => {}}`**

In `test/unit/client/components/ContextMenuProvider.test.tsx`:

- Import `act` and `waitFor` from Testing Library.
- Import `PaneLayout`.
- Add a small `createStoreWithBrowserSplitPaneLayout()` helper using the same store pattern already present in the file, but with a two-browser split layout and `activePane['tab-1']` starting at `pane-1`.

Then add this regression:

```tsx
it('keeps the menu open when right-clicking an inactive browser pane shell', async () => {
  const user = userEvent.setup()
  const store = createStoreWithBrowserSplitPaneLayout()

  const { container } = render(
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
    </Provider>
  )

  const inactivePane = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"]',
  ) as HTMLElement

  await user.pointer({ target: inactivePane, keys: '[MouseRight]' })

  await waitFor(() => {
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
  })

  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(screen.getByRole('menu')).toBeInTheDocument()
})
```

Do not use the old bare `Pane` + `onFocus={() => {}}` pattern for this regression. That was the second review gap.

**Step 3: Run the route regressions and require at least one automated red path**

Run:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on at least one inactive-path regression if the current automated surfaces reproduce the user bug.

If everything stays green:

1. Manually reproduce the bug in the worktree on the real app.
2. Identify the exact failing route: browser shell, terminal header, or terminal body; active vs inactive.
3. Convert that exact route into an automated red test before touching production code.
4. For any inactive terminal route, do not stop at `activePane` state. Add the terminal-focus diagnostic in Step 4 before editing production code.

**Step 4: If an inactive terminal route is the red path, prove the refocus leg in the existing lifecycle harness**

If the failing automated or manual route is terminal-specific, extend `test/unit/client/components/TerminalView.lifecycle.test.tsx`. Reuse that file's existing `terminalInstances`, `requestAnimationFrame` stub, xterm mocks, and Redux setup. Add imports for `screen`, `userEvent`, `PaneLayout`, and `ContextMenuProvider`.

Create a two-terminal split layout helper in that file and render it under the real provider so the exact right-click path runs through `Pane`, `PaneLayout`, and `TerminalView`.

The diagnostic test should look like this:

```tsx
it('right-clicking an inactive terminal body activates the pane and schedules term.focus()', async () => {
  const store = createTerminalContextMenuStore()
  const user = userEvent.setup()

  const { container } = render(
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
    </Provider>
  )

  await waitFor(() => {
    expect(terminalInstances).toHaveLength(2)
  })

  const inactiveBody = container.querySelector(
    '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-container"]',
  ) as HTMLElement

  const focusCallsBefore = terminalInstances[1].focus.mock.calls.length

  await user.pointer({ target: inactiveBody, keys: '[MouseRight]' })

  await waitFor(() => {
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
  })
  expect(terminalInstances[1].focus.mock.calls.length).toBeGreaterThan(focusCallsBefore)
  expect(screen.getByRole('menu')).toBeInTheDocument()
})
```

Use the exact failing route from Step 3: header if the header route is red, body if the body route is red. This closes the first review gap completely by requiring the red test to observe both activation and refocus before the menu is expected to survive.

Run:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  --reporter=dot
```

Expected: FAIL on the terminal-specific diagnostic until the real cause is fixed.

**Step 5: Write the minimal production fix the red tests justify**

Choose the production change from the first proven failing path:

- If the inactive browser-pane regression fails before any terminal refocus evidence is involved, inspect `src/components/context-menu/ContextMenuProvider.tsx` first and patch only the dismissal path that the red test proves is wrong.
- If the failing route is an inactive terminal header or body route and the lifecycle diagnostic shows the refocus leg runs during menu open, inspect `src/components/panes/Pane.tsx` and `src/components/TerminalView.tsx` together and add the smallest guard that preserves left-click activation while avoiding the context-menu close.
- If the failing route only proves `Pane.onMouseDown` is the issue, keep the fix there and do not change terminal focus behavior.
- If the failing route only proves provider dismissal is the issue, keep the fix in `ContextMenuProvider.tsx` and do not add pane/terminal guards.
- Do not land a speculative product rule like "right-click never activates panes" unless the red tests force that behavior.

**Step 6: Re-run the relevant regressions and verify they pass**

Run at minimum:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

If Step 4 was needed, include `test/unit/client/components/TerminalView.lifecycle.test.tsx` in the same rerun.

Expected: PASS for the inactive activation routes and, when applicable, the terminal refocus diagnostic.

**Step 7: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/refresh-context-menu-flow.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

Only stage files you actually changed. If the terminal lifecycle file was not needed, leave it out of the commit.

### Task 3: Run The Verification Gate And Spot-Check The Real App

**Files:**
- None

**Step 1: Run the focused client regression pack**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  --reporter=dot
```

If Task 2 needed the terminal-focus diagnostic, add `test/unit/client/components/TerminalView.lifecycle.test.tsx` to the same command.

Expected: PASS for the clipboard contract plus the inactive-pane menu-stability regressions.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS with no new a11y or TypeScript issues from the menu rendering or event handling changes.

**Step 3: Run the full required test suite**

Run:

```bash
npm test
```

Expected: PASS for the full repo test suite.

**Step 4: Manually validate in the worktree on isolated ports**

Do not use `npm run dev` or `npm run dev:server`; those scripts hard-code `PORT=3002`. Start isolated worktree processes explicitly:

```bash
PORT=3344 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=5174 npm run dev:client > /tmp/freshell-5174-client.log 2>&1 & echo $! > /tmp/freshell-5174-client.pid
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
readlink -f "/proc/$(cat /tmp/freshell-3344-server.pid)/cwd"
ps -fp "$(cat /tmp/freshell-5174-client.pid)"
readlink -f "/proc/$(cat /tmp/freshell-5174-client.pid)/cwd"
```

Open `http://127.0.0.1:5174` and verify:

- Right-clicking the inactive browser pane shell leaves the custom menu open.
- Right-clicking the inactive terminal pane header leaves the custom menu open.
- Right-clicking the inactive terminal text area leaves the custom menu open.
- The first terminal menu section is `copy`, `Paste`, `Select all`, each with an icon.
- `copy` is disabled when there is no terminal selection and enabled when text is selected.
- `Paste`, `Select all`, `Search`, `Refresh pane`, and the remaining terminal actions still work.

**Step 5: Stop the worktree-only processes cleanly**

Run:

```bash
kill "$(cat /tmp/freshell-5174-client.pid)"
rm -f /tmp/freshell-5174-client.pid
kill "$(cat /tmp/freshell-3344-server.pid)"
rm -f /tmp/freshell-3344-server.pid
```

Expected: only the recorded worktree processes stop, with no impact on the main-branch server that owns this session.
