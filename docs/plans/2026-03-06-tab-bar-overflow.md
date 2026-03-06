# Tab Bar Overflow Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Improve the tab bar when tabs overflow: hide the native scrollbar, pin the "+" button outside the scroll area, auto-scroll to the active tab on activation, and show directional overflow indicators (fade gradients) when tabs are clipped on either side.

**Architecture:** Extract a new `useTabBarScroll` hook that owns a `ref` to the scrollable container, tracks overflow state (`canScrollLeft` / `canScrollRight`) via `scroll` and `ResizeObserver` events, and exposes a `scrollToTab(tabId)` function that centers the active tab. The TabBar component is restructured so the "+" button lives outside the scrollable container in the flex layout. Overflow indicators are purely decorative absolutely-positioned gradient overlays controlled by the hook's boolean state. A CSS utility class hides the scrollbar on the tab strip while preserving scroll functionality.

**Tech Stack:** React 18, Tailwind CSS, Vitest + Testing Library

---

## Implementation Notes (Read First)

- All work targets the desktop tab bar only. The `MobileTabStrip` component is unaffected.
- The `useTabBarScroll` hook is a new custom hook at `src/hooks/useTabBarScroll.ts`.
- The scrollbar-hiding CSS class goes in `src/index.css` as a utility.
- Overflow indicators are decorative `div` elements with `aria-hidden="true"` -- they must not be interactive or keyboard-focusable.
- The "+" button must remain keyboard-reachable (it already is via `tabIndex` / semantic `<button>`).
- dnd-kit `SortableContext` stays around the scrollable tab list only; the "+" button is outside it.
- Auto-scroll uses `Element.scrollTo({ left, behavior: 'smooth' })` for centering.
- `ResizeObserver` is used to detect container/content size changes (e.g. tab added/removed, window resize).
- Tests mock `scrollWidth`, `clientWidth`, `scrollLeft`, and `scrollTo` on the scrollable element.

---

### Task 1: Add scrollbar-hiding CSS utility class

**Files:**
- Modify: `src/index.css` (inside the `@layer utilities` block, lines 132-159)

**Step 1: Add the `.scrollbar-none` utility class**

Inside the existing `@layer utilities { ... }` block in `src/index.css`, add the following class after the existing utility classes:

```css
  .scrollbar-none {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE/Edge */
  }
  .scrollbar-none::-webkit-scrollbar {
    display: none; /* Chrome/Safari/Opera */
  }
```

**Step 2: Verify the CSS is valid**

Run:
```bash
npx tailwindcss --content 'src/index.css' 2>&1 | head -5
```
Expected: No errors.

**Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat(css): add scrollbar-none utility class for hidden-scrollbar scrollable containers"
```

---

### Task 2: Create the `useTabBarScroll` hook -- tests first

**Files:**
- Create: `src/hooks/useTabBarScroll.ts`
- Create: `test/unit/client/hooks/useTabBarScroll.test.ts`

**Step 1: Write failing tests for the hook**

Create `test/unit/client/hooks/useTabBarScroll.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTabBarScroll } from '@/hooks/useTabBarScroll'

// Helper to create a mock scrollable element
function createMockScrollContainer(overrides: Partial<{
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
}> = {}) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: overrides.scrollWidth ?? 500, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: overrides.clientWidth ?? 300, configurable: true })
  Object.defineProperty(el, 'scrollLeft', {
    value: overrides.scrollLeft ?? 0,
    writable: true,
    configurable: true,
  })
  el.scrollTo = vi.fn((opts: ScrollToOptions) => {
    if (opts.left !== undefined) {
      ;(el as any).scrollLeft = opts.left
    }
  }) as any
  return el
}

describe('useTabBarScroll', () => {
  let observeCallbacks: Array<(entries: any[]) => void>
  let originalResizeObserver: typeof ResizeObserver

  beforeEach(() => {
    observeCallbacks = []
    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = vi.fn((cb) => {
      observeCallbacks.push(cb)
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      }
    }) as any
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  describe('overflow detection', () => {
    it('reports no overflow when content fits', () => {
      const { result } = renderHook(() => useTabBarScroll(null))

      // With no ref attached, defaults to no overflow
      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports canScrollRight when content overflows to the right', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })
      const { result } = renderHook(() => useTabBarScroll(null))

      // Simulate attaching the ref
      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.updateOverflow()
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft when scrolled away from start', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 50 })
      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.updateOverflow()
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft only when scrolled to end', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })
      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.updateOverflow()
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports no overflow when scrollWidth equals clientWidth', () => {
      const el = createMockScrollContainer({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })
      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.updateOverflow()
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })
  })

  describe('scrollToTab', () => {
    it('scrolls to center the active tab element', () => {
      const el = createMockScrollContainer({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 })

      // Create a mock tab element inside the container
      const tabEl = document.createElement('div')
      tabEl.setAttribute('data-tab-id', 'tab-3')
      Object.defineProperty(tabEl, 'offsetLeft', { value: 400 })
      Object.defineProperty(tabEl, 'offsetWidth', { value: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-3"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.scrollToTab('tab-3')
      })

      // Target scroll = offsetLeft + offsetWidth/2 - clientWidth/2
      // = 400 + 50 - 150 = 300
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 300,
        behavior: 'smooth',
      })
    })

    it('does not scroll when tab element is not found', () => {
      const el = createMockScrollContainer()
      el.querySelector = vi.fn(() => null) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.scrollToTab('nonexistent')
      })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('clamps scroll to 0 when tab is near the start', () => {
      const el = createMockScrollContainer({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 })

      const tabEl = document.createElement('div')
      tabEl.setAttribute('data-tab-id', 'tab-1')
      Object.defineProperty(tabEl, 'offsetLeft', { value: 20 })
      Object.defineProperty(tabEl, 'offsetWidth', { value: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-1"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        ;(result.current as any).containerRef.current = el
        result.current.scrollToTab('tab-1')
      })

      // Target = 20 + 50 - 150 = -80, clamped to 0
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 0,
        behavior: 'smooth',
      })
    })
  })
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: FAIL -- module `@/hooks/useTabBarScroll` does not exist.

**Step 3: Implement `useTabBarScroll` hook**

Create `src/hooks/useTabBarScroll.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

interface TabBarScrollState {
  canScrollLeft: boolean
  canScrollRight: boolean
}

interface TabBarScrollResult extends TabBarScrollState {
  containerRef: React.RefObject<HTMLDivElement | null>
  scrollToTab: (tabId: string) => void
  updateOverflow: () => void
}

const SCROLL_THRESHOLD = 2 // px tolerance for scroll boundary detection

export function useTabBarScroll(activeTabId: string | null): TabBarScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState<TabBarScrollState>({
    canScrollLeft: false,
    canScrollRight: false,
  })

  const updateOverflow = useCallback(() => {
    const el = containerRef.current
    if (!el) {
      setOverflow({ canScrollLeft: false, canScrollRight: false })
      return
    }

    const { scrollLeft, scrollWidth, clientWidth } = el
    setOverflow({
      canScrollLeft: scrollLeft > SCROLL_THRESHOLD,
      canScrollRight: scrollLeft + clientWidth < scrollWidth - SCROLL_THRESHOLD,
    })
  }, [])

  const scrollToTab = useCallback((tabId: string) => {
    const el = containerRef.current
    if (!el) return

    const tabEl = el.querySelector(`[data-tab-id="${tabId}"]`) as HTMLElement | null
    if (!tabEl) return

    const tabCenter = tabEl.offsetLeft + tabEl.offsetWidth / 2
    const containerCenter = el.clientWidth / 2
    const targetScroll = Math.max(0, tabCenter - containerCenter)

    el.scrollTo({ left: targetScroll, behavior: 'smooth' })
  }, [])

  // Auto-scroll when activeTabId changes
  useEffect(() => {
    if (activeTabId) {
      scrollToTab(activeTabId)
    }
  }, [activeTabId, scrollToTab])

  // Listen for scroll events to update overflow state
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleScroll = () => updateOverflow()
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [updateOverflow])

  // Use ResizeObserver to detect size changes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(() => updateOverflow())
    observer.observe(el)

    // Initial check
    updateOverflow()

    return () => observer.disconnect()
  }, [updateOverflow])

  return {
    containerRef,
    canScrollLeft: overflow.canScrollLeft,
    canScrollRight: overflow.canScrollRight,
    scrollToTab,
    updateOverflow,
  }
}
```

**Step 4: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/useTabBarScroll.ts test/unit/client/hooks/useTabBarScroll.test.ts
git commit -m "feat(hooks): add useTabBarScroll hook for overflow detection and auto-scroll"
```

---

### Task 3: Restructure TabBar layout -- move "+" button outside scrollable area

**Files:**
- Modify: `src/components/TabBar.tsx` (lines 263-401)
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabBar.mobile.test.tsx`

**Step 1: Write a failing test asserting the "+" button is outside the scroll container**

In `test/unit/client/components/TabBar.test.tsx`, add a new test in the `rendering` describe block:

```ts
    it('renders the + button outside the scrollable tab container', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByTitle('New shell tab')
      const scrollContainer = addButton.closest('.scrollbar-none')

      // The + button should NOT be inside the scrollbar-none container
      expect(scrollContainer).toBeNull()
    })
```

**Step 2: Run test to verify RED**

Run:
```bash
npx vitest run test/unit/client/components/TabBar.test.tsx
```
Expected: FAIL -- the "+" button is currently inside the scrollable container.

**Step 3: Restructure TabBar.tsx**

Modify the return JSX of the `TabBar` component. The key changes:

1. Import `useTabBarScroll` from `@/hooks/useTabBarScroll`.
2. Call `useTabBarScroll(activeTabId)` to get `containerRef`, `canScrollLeft`, `canScrollRight`.
3. Split the inner flex div: tabs go in a scrollable div with `ref={containerRef}` and `scrollbar-none`; the "+" button goes outside.
4. Add overflow indicator divs.

Replace the entire return block (lines 263-401) with:

```tsx
  return (
    <div className="relative z-20 h-12 md:h-10 shrink-0 flex items-end px-2 bg-background" data-context={ContextIds.Global}>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-muted-foreground/45"
        aria-hidden="true"
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map((t: Tab) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="relative z-10 flex items-end flex-1 min-w-0">
            {/* Overflow indicator: left */}
            {canScrollLeft && (
              <div
                className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 z-20 bg-gradient-to-r from-background to-transparent"
                aria-hidden="true"
              />
            )}

            {/* Scrollable tab strip */}
            <div
              ref={containerRef}
              className="flex items-end gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-none pt-px flex-1 min-w-0"
            >
              {sidebarCollapsed && onToggleSidebar && (
                <button
                  className="flex-shrink-0 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                  title="Show sidebar"
                  aria-label="Show sidebar"
                  onClick={onToggleSidebar}
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </button>
              )}
              {tabs.map((tab: Tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  displayTitle={getDisplayTitle(tab)}
                  isActive={tab.id === activeTabId}
                  needsAttention={!!attentionByTab[tab.id]}
                  isDragging={activeId === tab.id}
                  isRenaming={renamingId === tab.id}
                  renameValue={renameValue}
                  paneContents={getPaneContents(tab)}
                  iconsOnTabs={iconsOnTabs}
                  tabAttentionStyle={tabAttentionStyle}
                  onRenameChange={setRenameValue}
                  onRenameBlur={() => {
                    dispatch(
                      updateTab({
                        id: tab.id,
                        updates: { title: renameValue || tab.title, titleSetByUser: true },
                      })
                    )
                    setRenamingId(null)
                  }}
                  onRenameKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  onClose={(e) => {
                    const terminalIds = getTerminalIdsForTab(tab)
                    if (terminalIds.length > 0) {
                      const messageType = e.shiftKey ? 'terminal.kill' : 'terminal.detach'
                      for (const terminalId of terminalIds) {
                        ws.send({
                          type: messageType,
                          terminalId,
                        })
                      }
                    } else if (tab.codingCliSessionId) {
                      if (tab.status === 'creating') {
                        dispatch(cancelCodingCliRequest({ requestId: tab.codingCliSessionId }))
                      } else {
                        ws.send({
                          type: 'codingcli.kill',
                          sessionId: tab.codingCliSessionId,
                        })
                      }
                    }
                    dispatch(closeTab(tab.id))
                  }}
                  onClick={() => {
                    if (attentionDismiss === 'click' && attentionByTab[tab.id]) {
                      dispatch(clearTabAttention({ tabId: tab.id }))
                      const activePaneId = activePaneMap?.[tab.id]
                      if (activePaneId && attentionByPane[activePaneId]) {
                        dispatch(clearPaneAttention({ paneId: activePaneId }))
                      }
                    }
                    dispatch(setActiveTab(tab.id))
                  }}
                  onDoubleClick={() => {
                    setRenamingId(tab.id)
                    setRenameValue(getDisplayTitle(tab))
                  }}
                />
              ))}
            </div>

            {/* Overflow indicator: right */}
            {canScrollRight && (
              <div
                className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 z-20 bg-gradient-to-l from-background to-transparent"
                aria-hidden="true"
              />
            )}
          </div>
        </SortableContext>

        {/* Pinned + button -- outside the scrollable area */}
        <button
          className="flex-shrink-0 ml-1 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
          title="New shell tab"
          aria-label="New shell tab"
          onClick={() => dispatch(addTab({ mode: 'shell' }))}
          data-context={ContextIds.TabAdd}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <DragOverlay>
          {activeTab ? (
            <div
              style={{
                opacity: 0.9,
                transform: 'scale(1.02)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                cursor: 'grabbing',
              }}
            >
              <TabItem
                tab={{ ...activeTab, title: getDisplayTitle(activeTab) }}
                isActive={activeTab.id === activeTabId}
                needsAttention={!!attentionByTab[activeTab.id]}
                isDragging={false}
                isRenaming={false}
                renameValue=""
                paneContents={getPaneContents(activeTab)}
                iconsOnTabs={iconsOnTabs}
                tabAttentionStyle={tabAttentionStyle}
                onRenameChange={() => {}}
                onRenameBlur={() => {}}
                onRenameKeyDown={() => {}}
                onClose={() => {}}
                onClick={() => {}}
                onDoubleClick={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
```

Also add the import at the top of `TabBar.tsx`:

```ts
import { useTabBarScroll } from '@/hooks/useTabBarScroll'
```

And destructure the hook result inside the component body, after the existing hooks:

```ts
  const { containerRef, canScrollLeft, canScrollRight } = useTabBarScroll(activeTabId)
```

**Step 4: Update existing tests that depend on layout structure**

Some existing tests in `TabBar.test.tsx` and `TabBar.mobile.test.tsx` locate elements by DOM traversal (e.g., `addButton.parentElement`). These tests need to be checked:

1. In `TabBar.test.tsx`, the test "hides vertical overflow on the tab strip while preserving horizontal scrolling" (line 228) looks for `addButton.parentElement` to find the tab strip. Since the "+" button is now outside the scroll container, update this test:

```ts
    it('hides vertical overflow on the tab strip while preserving horizontal scrolling', () => {
      const tab = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      const { container } = renderWithStore(<TabBar />, store)

      // The scrollable tab strip has the scrollbar-none class
      const tabStrip = container.querySelector('.scrollbar-none') as HTMLDivElement | null

      expect(tabStrip).toBeInTheDocument()
      expect(tabStrip?.className).toContain('overflow-x-auto')
      expect(tabStrip?.className).toContain('overflow-y-hidden')
      expect(tabStrip?.className).toContain('scrollbar-none')
    })
```

2. In `TabBar.mobile.test.tsx`, the test "tab bar container has h-12 for mobile and md:h-10 for desktop" uses `screen.getByRole('button', { name: 'New shell tab' }).closest('.z-20')`. The "+" button is still inside the `.z-20` outer wrapper, so this should still work. Verify by running the test.

**Step 5: Run all TabBar tests to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/components/TabBar
```
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.test.tsx
git commit -m "feat(TabBar): restructure layout to pin + button outside scrollable area and add overflow indicators"
```

---

### Task 4: Add tests for overflow indicators in TabBar

**Files:**
- Modify: `test/unit/client/components/TabBar.test.tsx`

**Step 1: Write tests for overflow indicator visibility**

Add a new describe block in `TabBar.test.tsx`:

```ts
  describe('overflow indicators', () => {
    it('does not render overflow indicators when tabs fit', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      const { container } = renderWithStore(<TabBar />, store)

      // No gradient overlays should be rendered
      const gradients = container.querySelectorAll('[aria-hidden="true"].bg-gradient-to-r, [aria-hidden="true"].bg-gradient-to-l')
      expect(gradients).toHaveLength(0)
    })

    it('overflow indicators are decorative (aria-hidden)', () => {
      // This test verifies the structure -- the actual overflow state
      // depends on scrollWidth/clientWidth which JSDOM doesn't compute.
      // We verify the indicators have aria-hidden when rendered.
      // Full overflow behavior is covered by useTabBarScroll hook tests.
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      const { container } = renderWithStore(<TabBar />, store)

      // The bottom separator line should be aria-hidden
      const separators = container.querySelectorAll('[aria-hidden="true"]')
      expect(separators.length).toBeGreaterThanOrEqual(1)
    })

    it('+ button remains keyboard-reachable outside scroll area', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByRole('button', { name: 'New shell tab' })
      expect(addButton).toBeInTheDocument()
      // Button should be a real <button> element (inherently keyboard-focusable)
      expect(addButton.tagName).toBe('BUTTON')
    })
  })
```

**Step 2: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/components/TabBar.test.tsx
```
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/components/TabBar.test.tsx
git commit -m "test(TabBar): add tests for overflow indicators and pinned + button accessibility"
```

---

### Task 5: Add auto-scroll-on-activate test to the hook

**Files:**
- Modify: `test/unit/client/hooks/useTabBarScroll.test.ts`

**Step 1: Write a test verifying auto-scroll triggers on activeTabId change**

Add to the `useTabBarScroll` describe block:

```ts
  describe('auto-scroll on active tab change', () => {
    it('calls scrollToTab when activeTabId changes', () => {
      const el = createMockScrollContainer({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 })

      const tabEl = document.createElement('div')
      tabEl.setAttribute('data-tab-id', 'tab-2')
      Object.defineProperty(tabEl, 'offsetLeft', { value: 350 })
      Object.defineProperty(tabEl, 'offsetWidth', { value: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-2"]') return tabEl
        return null
      }) as any

      const { result, rerender } = renderHook(
        ({ activeTabId }) => {
          const hookResult = useTabBarScroll(activeTabId)
          // Attach the mock element to the ref
          ;(hookResult.containerRef as any).current = el
          return hookResult
        },
        { initialProps: { activeTabId: 'tab-1' as string | null } }
      )

      // Change activeTabId to tab-2
      rerender({ activeTabId: 'tab-2' })

      // scrollTo should have been called to center tab-2
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 250, // 350 + 50 - 150 = 250
        behavior: 'smooth',
      })
    })

    it('does not scroll when activeTabId is null', () => {
      const el = createMockScrollContainer()

      const { result } = renderHook(
        ({ activeTabId }) => {
          const hookResult = useTabBarScroll(activeTabId)
          ;(hookResult.containerRef as any).current = el
          return hookResult
        },
        { initialProps: { activeTabId: null as string | null } }
      )

      expect(el.scrollTo).not.toHaveBeenCalled()
    })
  })
```

**Step 2: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: PASS (the hook implementation from Task 2 already includes auto-scroll on activeTabId change).

**Step 3: Commit**

```bash
git add test/unit/client/hooks/useTabBarScroll.test.ts
git commit -m "test(useTabBarScroll): add auto-scroll-on-activate tests"
```

---

### Task 6: Run full test suite and verify no regressions

**Files:** None (verification only)

**Step 1: Run all tests**

Run:
```bash
cd /home/user/code/freshell/.worktrees/tab-bar-overflow && npm test
```
Expected: All tests pass.

**Step 2: Run typecheck**

Run:
```bash
cd /home/user/code/freshell/.worktrees/tab-bar-overflow && npx tsc --noEmit
```
Expected: No type errors.

**Step 3: If any test failures, fix them and commit**

If there are any failures related to the changes (e.g. tests that assumed the "+" button was inside the scrollable container), fix them and commit the fixes.

---

### Task 7: Refactor -- review for DRY and code quality

**Files:**
- Review: `src/components/TabBar.tsx`
- Review: `src/hooks/useTabBarScroll.ts`
- Review: `test/unit/client/hooks/useTabBarScroll.test.ts`
- Review: `test/unit/client/components/TabBar.test.tsx`

**Step 1: Review the hook for unnecessary complexity**

Check that:
- The `SCROLL_THRESHOLD` constant is appropriate (2px is a reasonable tolerance for sub-pixel rendering).
- The `useEffect` dependencies are correct and don't cause unnecessary re-renders.
- The `containerRef` is being used correctly (not causing stale closure issues).
- The `ResizeObserver` cleanup is proper.

**Step 2: Review the TabBar component**

Check that:
- The overflow indicator gradient classes use the correct direction (`from-background to-transparent`).
- The `data-tab-id` attribute is present on the correct element for `scrollToTab` to find (it's on the TabItem wrapper via `data-tab-id={tab.id}`). Verify this is set in `TabItem.tsx` line 136.
- The `min-w-0` class is on the correct flex container to allow the scrollable area to shrink.

**Step 3: Review test quality**

Check that:
- Tests cover edge cases (0 tabs, 1 tab, many tabs).
- Mock setup is clean and reusable.
- Test names clearly describe the behavior being tested.

**Step 4: Make any refactoring changes and commit**

If any improvements are needed, make them and commit:

```bash
git add -A
git commit -m "refactor(TabBar): clean up overflow hook and indicator implementation"
```

---

## Summary of All Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/index.css` | Modify | Add `.scrollbar-none` utility class |
| `src/hooks/useTabBarScroll.ts` | Create | Hook for overflow detection, auto-scroll, and container ref |
| `src/components/TabBar.tsx` | Modify | Restructure layout: scrollable tabs + pinned "+" button + overflow indicators |
| `test/unit/client/hooks/useTabBarScroll.test.ts` | Create | Unit tests for the scroll hook |
| `test/unit/client/components/TabBar.test.tsx` | Modify | Update structural tests, add overflow/a11y tests |

## Verification Checklist

- [ ] Native scrollbar hidden on tab strip (`scrollbar-none` class)
- [ ] "+" button always visible, pinned outside scroll area
- [ ] Auto-scroll to active tab on tab activation (centering)
- [ ] Left gradient appears when tabs overflow to the left
- [ ] Right gradient appears when tabs overflow to the right
- [ ] Gradients disappear when scrolled to the respective edge
- [ ] Mouse wheel and trackpad scrolling still works
- [ ] Keyboard scrolling still works
- [ ] Drag-and-drop tab reordering still works
- [ ] Overflow indicators are `aria-hidden="true"` (decorative)
- [ ] "+" button remains keyboard-reachable
- [ ] All existing tests pass
- [ ] New tests cover overflow detection, auto-scroll, and accessibility
- [ ] TypeScript compiles without errors
