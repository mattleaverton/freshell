# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Ground the work in the repo's real testing surfaces instead of invented harnesses. Use `test/unit/client/context-menu/menu-defs.test.ts` to lock down the menu contract, `test/unit/client/components/ContextMenuProvider.test.tsx` to verify the rendered DOM order/icons through the real provider and to hold one provider-level "menu stays open" regression, and `test/e2e/refresh-context-menu-flow.test.tsx` for the user-visible active/inactive route matrix across browser pane shell, terminal pane header/shell, and terminal body. Only if the failing route is terminal-specific and not explained by the provider-level regression should you extend `test/unit/client/components/TerminalView.lifecycle.test.tsx`, reusing its full xterm/mock scaffolding, to diagnose terminal focus timing. Let the first red test decide whether the fix belongs in `ContextMenuProvider.tsx`, `Pane.tsx`, `TerminalView.tsx`, or a minimal combination.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket, persistence, or protocol changes.
- No `docs/index.html` update; this is localized menu polish and a regression fix, not a new user flow.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not pre-commit to a provider-only fix or to changing pane activation semantics. Choose the smallest production change the red tests justify on the exact failing surface.
- Do not invent lightweight terminal harnesses when the repo already has a full xterm-backed test scaffold in `test/unit/client/components/TerminalView.lifecycle.test.tsx`.

### Task 1: Rebuild And Render The Terminal Clipboard Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing menu-contract tests**

In `test/unit/client/context-menu/menu-defs.test.ts`, add or update terminal-menu coverage so the contract is explicit:

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

Expected red state: the current menu still labels copy differently, the clipboard items are not the first section, and the items have no icons.

**Step 2: Write the failing rendered-DOM regression**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, add a rendered assertion that opens a real terminal context menu through the provider and verifies what `ContextMenu.tsx` actually renders. Reuse the existing terminal-pane preloaded-state pattern already present in this file; if the nested `createStoreWithTerminalPane()` helper in the `Replace pane` block is not reusable as-is, extract a small file-scope helper before adding the new test.

Add a test along these lines:

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

That keeps the visible result under automated test instead of stopping at `buildMenuItems(...)`.

**Step 3: Run the targeted Task 1 tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on the new clipboard ordering/label/icon assertions.

**Step 4: Write the minimal production change**

Update `src/components/context-menu/menu-defs.ts`:

- Keep the file as `.ts`; use `createElement(...)`, not JSX.
- Import `createElement` plus Lucide icons for copy, paste, and select-all.
- Build a dedicated clipboard helper that returns:
  - `terminal-copy` labeled exactly `copy`
  - `terminal-paste` labeled `Paste`
  - `terminal-select-all` labeled `Select all`
  - icons on all three items
- Insert that helper at the top of the terminal-menu branch, followed by a dedicated separator id such as `terminal-clipboard-sep`.
- Leave `terminal-search` outside that top clipboard section.
- Preserve existing enabled/disabled behavior and existing ids.

**Step 5: Re-run the targeted Task 1 tests and verify they pass**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS for both the contract-level and rendered-DOM clipboard checks.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Add Executable Route Regressions, Diagnose The First Red Path, And Fix It

**Files:**
- Modify as needed: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify as needed: `src/components/panes/Pane.tsx`
- Modify as needed: `src/components/TerminalView.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify only if terminal-specific diagnosis is needed: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Add the user-visible route matrix in the existing e2e file**

In `test/e2e/refresh-context-menu-flow.test.tsx`, do not refer to imaginary shared helpers. Add the small helpers you need directly in this file, beside the real existing ones:

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

async function expectMenuStaysOpenAfterRightClick(target: HTMLElement) {
  const user = userEvent.setup()
  await user.pointer({ target, keys: '[MouseRight]' })
  await waitForTwoPaints()
  expect(screen.getByRole('menu')).toBeInTheDocument()
}
```

Then add the six concrete route regressions the accepted medium strategy requires:

- Browser pane shell, already-active pane:
  - `renderFlow(createStore(createBrowserSplitLayout()))`
  - target: `[data-context="pane"][data-pane-id="pane-1"]`
- Browser pane shell, inactive pane:
  - same layout
  - target: `[data-context="pane"][data-pane-id="pane-2"]`
- Terminal pane header/shell, already-active pane:
  - `renderFlow(createStore(createTerminalSplitLayout()))`
  - target: `[data-context="pane"][data-pane-id="pane-1"] [role="banner"]`
- Terminal pane header/shell, inactive pane:
  - same layout
  - target: `[data-context="pane"][data-pane-id="pane-2"] [role="banner"]`
- Terminal body, already-active pane:
  - wait for two `[data-testid="terminal-xterm-container"]` nodes
  - target: `[data-context="terminal"][data-pane-id="pane-1"] [data-testid="terminal-xterm-container"]`
- Terminal body, inactive pane:
  - same selector pattern for `pane-2`

For every route, assert the menu still exists after two paints. Keep these tests in the existing file so they exercise the real `PaneLayout`, provider, and terminal/browser pane wiring already present there.

**Step 2: Add one provider-level "stays open" regression in the existing unit file**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, add a single pane-shell regression using the real `Pane` harness already in that file:

```tsx
it('keeps the pane menu open after right-clicking the pane shell', async () => {
  const user = userEvent.setup()
  const store = createStoreWithBrowserPane()

  render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <Pane
          tabId="tab-1"
          paneId="pane-1"
          isActive={true}
          isOnlyPane={true}
          title="Browser"
          content={{
            kind: 'browser',
            browserInstanceId: 'browser-1',
            url: 'https://example.com',
            devToolsOpen: false,
          }}
          onClose={() => {}}
          onFocus={() => {}}
        >
          <div>Pane body</div>
        </Pane>
      </ContextMenuProvider>
    </Provider>
  )

  await user.pointer({ target: screen.getByRole('group', { name: 'Pane: Browser' }), keys: '[MouseRight]' })
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(screen.getByRole('menu')).toBeInTheDocument()
})
```

This gives you a unit-level reproduction on a real pane-shell route without inventing a new provider harness.

**Step 3: Run the route regressions and verify at least one test goes red**

Run:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on at least one route if the bug is reproducible in the existing Vitest surfaces.

If these tests stay green:

1. Reproduce the bug manually in the worktree on the real app.
2. Identify the exact failing route: browser shell, terminal header/shell, or terminal body, and whether it is active-only, inactive-only, or both.
3. Convert that exact route into a failing automated test before any production edit:
   - first choice: extend `test/e2e/refresh-context-menu-flow.test.tsx` with a more precise selector or event sequence;
   - second choice: extend `test/unit/client/components/ContextMenuProvider.test.tsx` if the route reproduces without xterm focus timing;
   - terminal-focus-only choice: extend `test/unit/client/components/TerminalView.lifecycle.test.tsx` using its existing full scaffolding, not a new lightweight xterm mock.
4. Re-run until at least one automated test is red. Do not edit production code before that.

**Step 4: Only if needed, diagnose terminal-specific focus timing in the existing lifecycle harness**

If the red route is terminal-specific and the provider-level pane-shell regression stays green, add a focused diagnostic to `test/unit/client/components/TerminalView.lifecycle.test.tsx` instead of inventing a new harness. Reuse that file's existing:

- hoisted `ws-client` mocks
- terminal theme / restore mocks
- `@xterm/xterm` mock and `terminalInstances`
- `@xterm/addon-fit` mock
- `MockResizeObserver`
- localStorage helpers

Add a new describe block that renders a two-terminal layout under `ContextMenuProvider` and `PaneLayout`, right-clicks the exact failing terminal header or terminal body route, waits two paints, and compares `terminalInstances[n].focus.mock.calls.length` before and after opening the menu. The point of this test is not to replace the e2e matrix; it is to explain whether `Pane.tsx` mouse handling or `TerminalView.tsx` active-terminal refocus is the earliest proven cause on the terminal-only route.

Run it together with the existing red tests:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  --reporter=dot
```

Expected: the lifecycle test only gets added if it helps convert the terminal-specific manual repro into an automated red diagnostic.

**Step 5: Write the minimal production fix the red tests justify**

Choose the fix path from the first proven failing surface:

- If the pane-shell regression fails in both the e2e file and `ContextMenuProvider.test.tsx` before any terminal-specific diagnostic is involved, inspect `src/components/context-menu/ContextMenuProvider.tsx` first and patch only the dismissal path the red test proves.
- If browser pane shell stays green while terminal header/body routes fail, inspect `src/components/panes/Pane.tsx` (`onMouseDown={onFocus}`) and `src/components/TerminalView.tsx` (active-terminal `requestAnimationFrame(...term.focus())`) together, then add the smallest guard that fixes the red route while preserving left-click activation and normal typing.
- If only an active-pane route fails, do not generalize it into an inactive-pane explanation.
- Do not land a provider timing guard and a pane/terminal focus change in the same first patch. Fix the earliest red cause, rerun, then add a second small fix only if another automated regression remains red.
- Do not hard-code new product behavior such as "secondary click never activates panes" unless the red tests and surrounding behavior checks require it.

**Step 6: Re-run the relevant regressions and verify they pass**

Run at minimum:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

If you added terminal-focus diagnostics, include `test/unit/client/components/TerminalView.lifecycle.test.tsx` in the same rerun.

Expected: PASS for the user-visible route matrix and the supporting unit regression(s).

**Step 7: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/refresh-context-menu-flow.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

Only stage files you actually changed. If no lifecycle test was needed, leave it out of the commit.

### Task 3: Run The Full Verification Gate And Manual Spot-Check

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

If Task 2 needed terminal-focus diagnostics, add `test/unit/client/components/TerminalView.lifecycle.test.tsx` to the same command.

Expected: PASS for the clipboard-section contract/render checks and the pane-menu stability regressions.

**Step 2: Run lint on the touched UI code**

Run:

```bash
npm run lint
```

Expected: PASS with no new React/TypeScript/a11y issues from the icon rendering or the menu-stability fix.

**Step 3: Run the full required test suite**

Run:

```bash
npm test
```

Expected: PASS for both the client and server Vitest runs.

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

- Right-clicking the already-active and inactive browser pane shell leaves the custom menu open.
- Right-clicking the already-active and inactive terminal pane header/shell leaves the custom menu open.
- Right-clicking inside the already-active and inactive terminal text area leaves the custom menu open.
- The first terminal menu section is `copy`, `Paste`, `Select all`, each with an icon.
- The rest of the terminal menu still includes refresh, split, search, scroll, clear, reset, and replace actions.

**Step 5: Stop the worktree-only processes cleanly**

Run:

```bash
kill "$(cat /tmp/freshell-5174-client.pid)"
rm -f /tmp/freshell-5174-client.pid
kill "$(cat /tmp/freshell-3344-server.pid)"
rm -f /tmp/freshell-3344-server.pid
```

Expected: only the recorded worktree processes stop; no broad kill patterns and no impact on the main-branch server that owns this session.
