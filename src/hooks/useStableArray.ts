import { useRef } from 'react'

/**
 * Returns a referentially stable array when the new array is element-wise
 * equal to the previous one. This prevents downstream consumers (like
 * react-window) from treating an identical list as changed and recomputing
 * all row elements.
 *
 * By default each element is compared with `===`. Pass a custom `isEqual`
 * function for structural comparison (e.g. comparing object fields).
 *
 * If the array length, element order, or any element differs, the new array
 * is returned and becomes the baseline for future comparisons.
 */
export function useStableArray<T>(
  next: T[],
  isEqual: (a: T, b: T) => boolean = Object.is,
): T[] {
  const ref = useRef(next)

  if (ref.current === next) return ref.current

  if (
    ref.current.length === next.length &&
    ref.current.every((item, i) => isEqual(item, next[i]))
  ) {
    return ref.current
  }

  ref.current = next
  return next
}
