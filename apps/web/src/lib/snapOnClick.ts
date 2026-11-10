import { useRef, type PointerEvent } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

/**
 * Handlers for a resize handle: a click (pointer down and up within 3px, so not a drag) snaps the panel back to `size` pixels.
 * Spread them onto the `ResizableHandle`.
 */
export function useSnapOnClick(panel: { current: PanelImperativeHandle | null }, size: number) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e: PointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current
      start.current = null
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 3) panel.current?.resize(size)
    },
  }
}
