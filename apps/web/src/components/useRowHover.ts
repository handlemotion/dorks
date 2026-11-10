import { useCallback, useEffect, useRef, useState } from 'react'

type Rect = { top: number; left: number; width: number; height: number }

/**
 * One hover fill for a list of `.sidebar-row`s inside a scrolling container: the rect of the row under the pointer, in the
 * container's coordinates, for `FluidHoverHighlight`. In the 2px gaps between rows it holds; over empty space it clears. `session`
 * changes each time the pointer enters, so the fill fades in where it lands instead of sliding from the last row. The lit row carries
 * `data-fluid-hover-active`.
 */
export function useRowHover() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ row: HTMLElement; rect: Rect } | null>(null)
  const [session, setSession] = useState(0)
  const measure = useCallback((row: HTMLElement): Rect | null => {
    const container = containerRef.current
    if (!container) return null
    const b = row.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    return { top: b.top - c.top + container.scrollTop, left: b.left - c.left + container.scrollLeft, width: b.width, height: b.height }
  }, [])
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMove = (event: MouseEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.sidebar-row')
      if (row) {
        const rect = measure(row)
        setHover(rect ? { row, rect } : null)
        return
      }
      const y = event.clientY - container.getBoundingClientRect().top + container.scrollTop
      let found: { row: HTMLElement; rect: Rect } | null = null
      for (const element of container.querySelectorAll<HTMLElement>('.sidebar-row')) {
        const rect = measure(element)
        if (rect && y >= rect.top - 2 && y <= rect.top + rect.height + 2) {
          found = { row: element, rect }
          break
        }
      }
      setHover(found)
    }
    const onEnter = () => setSession((s) => s + 1)
    const onLeave = () => setHover(null)
    container.addEventListener('mousemove', onMove)
    container.addEventListener('mouseenter', onEnter)
    container.addEventListener('mouseleave', onLeave)
    return () => {
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseenter', onEnter)
      container.removeEventListener('mouseleave', onLeave)
    }
  }, [measure])
  const row = hover?.row
  useEffect(() => {
    row?.setAttribute('data-fluid-hover-active', '')
    return () => row?.removeAttribute('data-fluid-hover-active')
  }, [row])
  return { containerRef, rect: hover?.rect ?? null, session }
}
