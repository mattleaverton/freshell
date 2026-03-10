# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus from immediately reclosing, and move terminal `copy`, `Paste`, and `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Solve the close-on-open bug at the pane interaction seam first. The code currently activates panes on every mouse button in `Pane`, which is the simplest plausible trigger for a right-click menu race on inactive panes; prove that with rendered regressions, then narrow pane activation to primary-button input unless the red tests prove a different close path. Keep the clipboard reorder entirely inside terminal menu definitions, and satisfy the user’s screenshot requirement with an automated screenshot artifact from the existing `captureUiScreenshot()` pipeline on the open menu state. No human/manual verification belongs in this plan.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, jsdom, html2canvas, xterm.js mocks

---

## Strategy Gate

- Solve exactly the user request:
  - right-clicking a pane must not cause the menu to flash open and immediately close
  - terminal `copy`, `Paste`, and `Select all` must be grouped at the very top
  - those three items must each render an icon
  - `copy` must be labeled exactly `copy`
- Do not require or describe any human/browser spot-check. The user explicitly rejected manual validation.
- Do not precommit to a speculative “context-menu opening marker” or similar side channel. Start with the simpler seam already visible in the code: `Pane` focuses on all mouse buttons today.
- Do not encode more product behavior than necessary. The contract is “menu stays open”; if the minimal fix happens to stop right-click activation, that is acceptable because it directly removes the race and preserves normal left-click activation.
- Keep the terminal menu reorder local to `src/components/context-menu/menu-defs.ts`. Do not rewrite the renderer.
- Treat automated screenshot output as evidence, not the primary behavioral oracle. The correctness contract still lives in deterministic rendered tests; the screenshot artifact exists because the user explicitly asked for it.
- No server, protocol, persistence, or docs work is needed for this task.

## Files That Matter

- `src/components/panes/Pane.tsx`
- `src/components/context-menu/menu-defs.ts`
- `src/components/context-menu/ContextMenu.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `test/e2e/refresh-context-menu-flow.test.tsx`
- `test/unit/client/components/context-menu/menu-defs.test.ts`
- `test/unit/client/components/ContextMenuProvider.test.tsx`
- `test/unit/client/ui-screenshot.test.ts`

### Task 1: Reproduce The Reclose Bug On The Real Terminal-Pane Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Build a two-terminal rendered harness**

Create `test/e2e/pane-context-menu-stability.test.tsx` using the same store/render pattern as `test/e2e/refresh-context-menu-flow.test.tsx`, but with two terminal panes so one is inactive.

Reuse:

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
import type { PaneNode } from '@/store/paneTypes'
```

Mock `@xterm/xterm` so each terminal creates a real descendant surface:

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
    scrollLines = vi.fn()
    scrollToBottom = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    paste = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn()
  }

  return { Terminal: MockTerminal }
})
```

Build a split layout with two terminal leaves and a helper that waits for the menu to settle:

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

function createLayout(): PaneNode {
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

async function settleMenu() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
```

**Step 2: Add the failing right-click regressions**

Add these tests:

```tsx
it('keeps the pane menu open when right-clicking an inactive terminal pane header', async () => {
  const store = createStore(createLayout())
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
  const store = createStore(createLayout())
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

it('still activates the inactive pane on primary click', async () => {
  const store = createStore(createLayout())
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

**Step 3: Run the file before changing production code**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected:
- the left-click control passes
- at least one of the right-click tests fails red against current code

### Task 2: Fix The Right-Click Interaction At The Simplest Proven Seam

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Re-run: `test/e2e/pane-context-menu-stability.test.tsx`
- Only if still red after the `Pane.tsx` fix: inspect and then modify the specific still-failing close path in `src/components/context-menu/ContextMenuProvider.tsx` or `src/components/TerminalView.tsx`

**Step 1: Narrow pane activation to primary-button mouse input**

In `src/components/panes/Pane.tsx`, replace unconditional pane focusing on `onMouseDown` with a guarded handler:

```tsx
const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
  if (event.button !== 0) return
  onFocus()
}
```

Then wire it at the root:

```tsx
onMouseDown={handleMouseDown}
```

Keep keyboard activation exactly as-is.

This is the preferred fix because it removes the most direct cause of the race without adding new state, timers, or context-menu-specific markers.

**Step 2: Re-run the stability regressions**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: all three tests pass.

If a right-click route is still red, do not invent a generic workaround. Trace the specific failing path and patch only that proven seam before moving on. The next places to inspect are:

- `src/components/context-menu/ContextMenuProvider.tsx` if the menu is being dismissed by its global listeners
- `src/components/TerminalView.tsx` if a terminal-specific focus path still fires on right-click after pane activation is fixed

**Step 3: Commit the stability fix**

```bash
git add src/components/panes/Pane.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep pane context menus open on right click"
```

### Task 3: Move Terminal Clipboard Actions Into Their Own Top Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing unit contract for terminal menu order, labels, icons, and wiring**

In `test/unit/client/components/context-menu/menu-defs.test.ts`, add a small harness helper:

```ts
function getTerminalItem(items: ReturnType<typeof buildMenuItems>, id: string) {
  const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
  expect(item?.type).toBe('item')
  if (!item || item.type !== 'item') throw new Error(`Missing terminal item: ${id}`)
  return item
}
```

Add these tests:

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

  it('preserves copy enabled state and action wiring', () => {
    const actions = createActions()
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

**Step 2: Add one rendered DOM proof of the visible order**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, add a terminal-target test that opens the menu and asserts the top section in rendered order:

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
    </Provider>,
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

If `createStoreWithTerminalPane()` does not already exist as a reusable helper in that file, extract it once near the other store factories instead of duplicating inline store setup inside the new test.

**Step 3: Run the clipboard tests before changing production code**

Run:

```bash
npx vitest run \
  test/unit/client/components/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: red on order, `copy` label, and icon presence.

**Step 4: Implement the terminal clipboard section**

In `src/components/context-menu/menu-defs.ts`:

- import `createElement` from `react`
- import `Copy`, `ClipboardPaste`, and `TextSelect` from `lucide-react`
- extract the clipboard trio into a helper
- place that trio at the very start of the terminal menu
- add a separator immediately after the trio
- keep existing action ids and enabled/disabled semantics intact

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

Then start the terminal menu branch with:

```ts
...buildTerminalClipboardItems(terminalActions, hasSelection),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

Everything else in the terminal menu should stay in its current relative order after that new first section.

**Step 5: Re-run the clipboard tests**

Run:

```bash
npx vitest run \
  test/unit/client/components/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 6: Commit the clipboard menu change**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: move terminal clipboard actions to top section"
```

### Task 4: Generate Automated Screenshot Proof For The Open Menu

**Files:**
- Modify: `test/unit/client/ui-screenshot.test.ts`

**Step 1: Add a screenshot proof test for the open terminal menu**

Extend `test/unit/client/ui-screenshot.test.ts` with one new case that renders an already-open terminal menu state, captures it through `captureUiScreenshot({ scope: 'view' }, runtime)`, and writes the returned PNG bytes to `/tmp/freshell-terminal-context-menu-proof.png`.

Use:

```ts
import fs from 'node:fs/promises'
```

Add a fixed proof path:

```ts
const CONTEXT_MENU_PROOF_PATH = '/tmp/freshell-terminal-context-menu-proof.png'
```

In the new test:

1. Render a minimal `ContextMenuProvider` + terminal target.
2. Open the terminal context menu with `user.pointer(..., '[MouseRight]')`.
3. Mock `html2canvas` exactly like the existing iframe tests do, so you can inspect the cloned screenshot DOM in `opts.onclone(...)` and still return a valid PNG data URL.
4. Call `captureUiScreenshot({ scope: 'view' }, runtime)`.
5. Write the resulting bytes:

```ts
await fs.writeFile(CONTEXT_MENU_PROOF_PATH, Buffer.from(result.imageBase64!, 'base64'))
```

6. Assert:

```ts
expect(result.ok).toBe(true)
expect(clonedHtml).toContain('copy')
expect(clonedHtml).toContain('Paste')
expect(clonedHtml).toContain('Select all')
expect((clonedHtml.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(3)
await expect(fs.stat(CONTEXT_MENU_PROOF_PATH)).resolves.toMatchObject({
  size: expect.any(Number),
})
```

This test is the screenshot proof the user asked for. The rasterizer is still mocked in jsdom, but the screenshot capture path, screenshot scope, and cloned open-menu DOM are real, and the test leaves behind a concrete PNG artifact for the execution report.

**Step 2: Run the screenshot proof test**

Run:

```bash
npx vitest run test/unit/client/ui-screenshot.test.ts --reporter=dot
```

Expected: PASS and `/tmp/freshell-terminal-context-menu-proof.png` exists.

**Step 3: Commit the screenshot proof**

```bash
git add test/unit/client/ui-screenshot.test.ts
git commit -m "test: capture terminal context menu screenshot proof"
```

### Task 5: Run The Automated Verification Gate

**Files:**
- None

**Step 1: Run the focused regression pack**

Run:

```bash
npx vitest run \
  test/e2e/pane-context-menu-stability.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/ui-screenshot.test.ts \
  test/unit/client/context-menu/menu-defs.test.ts \
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

**Step 6: Record proof outputs in the execution report**

The final execution report must mention:

- the passing reclose regression file: `test/e2e/pane-context-menu-stability.test.tsx`
- the passing menu-structure files:
  - `test/unit/client/components/context-menu/menu-defs.test.ts`
  - `test/unit/client/components/ContextMenuProvider.test.tsx`
- the screenshot proof path:

```text
/tmp/freshell-terminal-context-menu-proof.png
```

Do not add any manual verification note. The user explicitly rejected human checks.
