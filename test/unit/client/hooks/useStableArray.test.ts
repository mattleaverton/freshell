import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStableArray } from '@/hooks/useStableArray'

describe('useStableArray', () => {
  describe('default (reference equality)', () => {
    it('returns the same reference when items are identical by reference', () => {
      const items = [{ id: 1 }, { id: 2 }]
      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: items } },
      )

      const first = result.current
      rerender({ arr: items })
      expect(result.current).toBe(first)
    })

    it('returns the same reference when a new array has identical item references', () => {
      const a = { id: 1 }
      const b = { id: 2 }
      const arr1 = [a, b]
      const arr2 = [a, b] // new array, same items

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).toBe(first)
    })

    it('returns a new reference when an item reference changes', () => {
      const a = { id: 1 }
      const b = { id: 2 }
      const arr1 = [a, b]
      const arr2 = [a, { id: 2 }] // new object for second item

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).not.toBe(first)
    })

    it('returns a new reference when array length changes', () => {
      const a = { id: 1 }
      const b = { id: 2 }
      const arr1 = [a, b]
      const arr2 = [a]

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).not.toBe(first)
    })

    it('returns a new reference when item order changes', () => {
      const a = { id: 1 }
      const b = { id: 2 }
      const arr1 = [a, b]
      const arr2 = [b, a]

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).not.toBe(first)
    })

    it('handles empty arrays', () => {
      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: [] as unknown[] } },
      )

      const first = result.current
      rerender({ arr: [] })
      expect(result.current).toBe(first)
    })

    it('transitions from empty to non-empty', () => {
      const a = { id: 1 }
      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr),
        { initialProps: { arr: [] as typeof a[] } },
      )

      const first = result.current
      rerender({ arr: [a] })
      expect(result.current).not.toBe(first)
      expect(result.current).toEqual([a])
    })
  })

  describe('custom comparator', () => {
    interface Item { id: number; value: string }
    const byId = (a: Item, b: Item) => a.id === b.id && a.value === b.value

    it('returns the same reference when new objects are structurally equal', () => {
      const arr1: Item[] = [{ id: 1, value: 'a' }, { id: 2, value: 'b' }]
      const arr2: Item[] = [{ id: 1, value: 'a' }, { id: 2, value: 'b' }] // new objects, same fields

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr, byId),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).toBe(first)
    })

    it('returns a new reference when a field value changes', () => {
      const arr1: Item[] = [{ id: 1, value: 'a' }, { id: 2, value: 'b' }]
      const arr2: Item[] = [{ id: 1, value: 'a' }, { id: 2, value: 'CHANGED' }]

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr, byId),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).not.toBe(first)
    })

    it('returns a new reference when order changes even if items are equal', () => {
      const arr1: Item[] = [{ id: 1, value: 'a' }, { id: 2, value: 'b' }]
      const arr2: Item[] = [{ id: 2, value: 'b' }, { id: 1, value: 'a' }]

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr, byId),
        { initialProps: { arr: arr1 } },
      )

      const first = result.current
      rerender({ arr: arr2 })
      expect(result.current).not.toBe(first)
    })

    it('stabilizes across multiple renders with unchanged data', () => {
      const make = (): Item[] => [{ id: 1, value: 'a' }, { id: 2, value: 'b' }]

      const { result, rerender } = renderHook(
        ({ arr }) => useStableArray(arr, byId),
        { initialProps: { arr: make() } },
      )

      const first = result.current
      rerender({ arr: make() })
      rerender({ arr: make() })
      rerender({ arr: make() })
      expect(result.current).toBe(first)
    })
  })
})
