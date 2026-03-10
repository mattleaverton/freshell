# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop pane right-click menus from immediately closing, and move terminal `copy`, `Paste`, and `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two small client changes with one shared TDD workflow. Prove the close-on-open regression on the real inactive terminal pane routes first, then fix the pane-shell secondary-click activation path in `Pane.tsx`. Separately, lock down the terminal menu contract at the builder layer and the rendered DOM layer before moving the clipboard items to the top of the terminal menu with icons.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, jsdom, xterm.js mocks

---

## Strategy Gate

- Solve only the requested behavior:
  - right-click must not immediately close the pane or terminal context menu
  - terminal `copy`, `Paste`, and `Select all` must be the first section
  - those three items must render icons
  - `copy` must be labeled exactly `copy`
- Use the real inactive-pane routes that exist in this repo:
  - terminal pane header right-click should open the pane menu and stay open
  - terminal body right-click should open the terminal menu and stay open
- Keep the proof seams fixed:
  - `test/e2e/pane-context-menu-stability.test.tsx` is the authoritative stability regression
  - `test/unit/client/context-menu/menu-defs.test.ts` is the authoritative terminal menu contract
  - `test/unit/client/components/ContextMenuProvider.test.tsx` proves the rendered top section and icon presence
- Do not use `test/unit/client/ui-screenshot.test.ts` for this task.
- Do not use `test/unit/client/components/context-menu/menu-defs.test.ts` for this task.
- Do not update `docs/index.html`; this is not a large enough UI change.
- After automated tests pass, require one short real-browser spot check in the worktree before closing the task.

## Files That Matter

- `src/components/panes/Pane.tsx`
- `src/components/context-menu/menu-defs.ts`
- `test/e2e/refresh-context-menu-flow.test.tsx`
- `test/e2e/terminal-paste-single-ingress.test.tsx`
- `test/unit/client/context-menu/menu-defs.test.ts`
- `test/unit/client/components/ContextMenuProvider.test.tsx`

### Task 1: Add A Red Regression For The Immediate-Reclose Bug

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`
- Reference: `test/e2e/refresh-context-menu-flow.test.tsx`
- Reference: `test/e2e/terminal-paste-single-ingress.test.tsx`

**Step 1: Create the shared harness**

Create `test/e2e/pane-context-menu-stability.test.tsx`.

Copy these unchanged from `test/e2e/refresh-context-menu-flow.test.tsx`:
- the `ws-client` mock
- the `api` mock
- the `url-rewrite` mock
- the `FloatingActionButton` mock
- the `IntersectionDragOverlay` mock
- `createTerminalLeaf`
- `createStore`
- `renderFlow`

Add the xterm mock pattern from `test/e2e/terminal-paste-single-ingress.test.tsx`, but make `open()` expose a right-clickable surface:

```tsx
const terminalInstances = vi.hoisted(() => [] as Array<{
  focus: ReturnType<typeof vi.fn>
  surface: HTMLElement | null
}>)

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    focus = vi.fn()
    surface: HTMLElement | null = null

    constructor() {
      terminalInstances.push(this)
    }

    open = vi.fn((element: HTMLElement) => {
      const surface = document.createElement('div')
      surface.setAttribute('data-testid', 'terminal-xterm-surface')
      surface.tabIndex = -1
      element.appendChild(surface)
      this.surface = surface
    })

    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    selectAll = vi.fn()
    scrollToBottom = vi.fn()
    paste = vi.fn()
    getSelection = vi.fn(() => '')
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    dispose = vi.fn()
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

Add the two-pane layout helper so `pane-2` starts inactive:

```tsx
function createTwoPaneLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
}
```

Add a small settle helper:

```tsx
async function settleMenu() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
```

**Step 2: Write the failing regressions**

Add these tests:

```tsx
it('keeps the pane menu open when right-clicking an inactive terminal pane header', async () => {
  const store = createStore(createTwoPaneLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const header = await waitFor(() => {
    const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await user.pointer({ target: header, keys: '[MouseRight]' })
  await settleMenu()

  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})

it('keeps the terminal menu open when right-clicking inside an inactive terminal body', async () => {
  const store = createStore(createTwoPaneLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const surface = await waitFor(() => {
    const node = container.querySelector('[data-pane-id="pane-2"] [data-testid="terminal-xterm-surface"]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await user.pointer({ target: surface, keys: '[MouseRight]' })
  await settleMenu()

  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Search' })).toBeInTheDocument()
})

it('still activates an inactive pane on primary click', async () => {
  const store = createStore(createTwoPaneLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  const header = await waitFor(() => {
    const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await user.pointer({ target: header, keys: '[MouseLeft]' })

  await waitFor(() => {
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
  })
})
```

**Step 3: Run the new test file to confirm red**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected:
- the left-click control passes
- at least one right-click test fails against current code

### Task 2: Fix The Secondary-Click Activation Path

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Test: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Guard pane activation to primary-button mouse-down**

In `src/components/panes/Pane.tsx`, replace the unconditional `onMouseDown={onFocus}` with:

```tsx
const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
  if (event.button !== 0) return
  onFocus()
}
```

Wire it on the pane shell:

```tsx
onMouseDown={handleMouseDown}
```

Do not change the existing keyboard activation behavior.

**Step 2: Re-run the stability regression**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: PASS.

**Step 3: Commit**

```bash
git add test/e2e/pane-context-menu-stability.test.tsx src/components/panes/Pane.tsx
git commit -m "fix: keep pane context menus open on right click"
```

### Task 3: Add Red Tests For The Terminal Clipboard Section

**Files:**
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Strengthen the builder contract**

In `test/unit/client/context-menu/menu-defs.test.ts`, add:

```ts
function getTerminalItem(items: ReturnType<typeof buildMenuItems>, id: string) {
  const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
  expect(item?.type).toBe('item')
  if (!item || item.type !== 'item') throw new Error(`Missing terminal item: ${id}`)
  return item
}
```

Add this block:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('places copy, Paste, and Select all in the first section with icons', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    expect(
      items.slice(0, 4).map((item) => item.type === 'item' ? item.id : item.type),
    ).toEqual([
      'terminal-copy',
      'terminal-paste',
      'terminal-select-all',
      'separator',
    ])

    expect(getTerminalItem(items, 'terminal-copy').label).toBe('copy')
    expect(getTerminalItem(items, 'terminal-copy').icon).toBeTruthy()
    expect(getTerminalItem(items, 'terminal-paste').icon).toBeTruthy()
    expect(getTerminalItem(items, 'terminal-select-all').icon).toBeTruthy()
  })

  it('keeps copy disabled until a selection exists, then calls copySelection', () => {
    const terminalActions = {
      copySelection: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clearScrollback: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      hasSelection: vi.fn(() => true),
      openSearch: vi.fn(),
    }

    const actions = createActions()
    actions.getTerminalActions = vi.fn(() => terminalActions)

    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions),
    )

    const copy = getTerminalItem(items, 'terminal-copy')
    expect(copy.disabled).toBe(false)
    copy.onSelect()
    expect(terminalActions.copySelection).toHaveBeenCalledTimes(1)
  })
})
```

Replace the existing order assertion for `Search` with:

```ts
it('"Search" appears after the clipboard section separator', () => {
  const items = buildMenuItems(
    { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
    makeCtx(createActions()),
  )

  const separatorIndex = items.findIndex((item) => item.type === 'separator' && item.id === 'terminal-clipboard-sep')
  const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

  expect(separatorIndex).toBeGreaterThanOrEqual(0)
  expect(searchIndex).toBeGreaterThan(separatorIndex)
})
```

**Step 2: Add the rendered DOM proof**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, lift `createStoreWithTerminalPane()` to file scope so both the existing replace-pane test and the new menu-render test can reuse it.

Add:

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
    children.slice(0, 4).map((node) =>
      node.getAttribute('role') === 'menuitem'
        ? node.textContent?.replace(/\s+/g, ' ').trim()
        : node.getAttribute('role'),
    ),
  ).toEqual(['copy', 'Paste', 'Select all', 'separator'])

  for (const node of children.slice(0, 3)) {
    expect(node.querySelector('svg')).not.toBeNull()
  }
})
```

**Step 3: Run the new tests to confirm red**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx --reporter=dot
```

Expected: FAIL on order, label, and icon assertions.

### Task 4: Move The Clipboard Actions To The Top Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Add iconized clipboard items**

At the top of `src/components/context-menu/menu-defs.ts`, add:

```ts
import { createElement } from 'react'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'
```

Add a helper above `buildMenuItems`:

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

**Step 2: Reorder the terminal menu**

In the `target.kind === 'terminal'` branch, start the returned array with:

```ts
...buildTerminalClipboardItems(terminalActions, hasSelection),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

Leave the remaining terminal actions in their current relative order after that separator:
- `Refresh pane`
- split actions
- `Search`
- resume command
- scrollback/reset actions
- `Replace pane`

Remove the old inline `terminal-copy`, `terminal-paste`, and `terminal-select-all` entries from their old position.

**Step 3: Re-run the targeted tests**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx --reporter=dot
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: move terminal clipboard actions to top section"
```

### Task 5: Full Verification And Required Browser Spot Check

**Files:**
- Modify: none

**Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS for both client and server Vitest suites.

If `npm test` fails, stop and fix the failures before doing anything with main.

**Step 2: Start an isolated worktree dev server**

Run:

```bash
PORT=3344 npx tsx watch server/index.ts > /tmp/freshell-pane-menu-3344.log 2>&1 & echo $! > /tmp/freshell-pane-menu-3344.pid
PORT=3344 VITE_PORT=5174 npx vite --port 5174 > /tmp/freshell-pane-menu-5174.log 2>&1 & echo $! > /tmp/freshell-pane-menu-5174.pid
```

**Step 3: Do the manual spot check**

Verify in a real browser against the worktree app:
- right-click the header of an inactive terminal pane; the pane menu should stay open
- right-click inside the body of an inactive terminal pane; the terminal menu should stay open
- terminal menu top section should read `copy`, `Paste`, `Select all`, each with an icon

**Step 4: Stop only the worktree processes**

Run:

```bash
ps -fp "$(cat /tmp/freshell-pane-menu-3344.pid)"
ps -fp "$(cat /tmp/freshell-pane-menu-5174.pid)"
kill "$(cat /tmp/freshell-pane-menu-3344.pid)"
kill "$(cat /tmp/freshell-pane-menu-5174.pid)"
rm -f /tmp/freshell-pane-menu-3344.pid /tmp/freshell-pane-menu-5174.pid
```

Confirm the `ps` output points at this worktree before killing either process.
