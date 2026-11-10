import { useEffect, useRef, type ComponentProps } from 'react'
import { cn } from 'cn'
import { ResizableHandle } from './resizable'

const HIT_SIZE = 24
const CLICK_TOLERANCE = 2

/** Dorks panel grip: beside the divider, visible on hover, keyboard focus and drag. */
export function PanelResizeHandle({
  className,
  onReset,
  side = 'start',
  disabled,
  ...props
}: Omit<ComponentProps<typeof ResizableHandle>, 'withHandle' | 'elementRef' | 'disableDoubleClick'> & {
  onReset: () => void
  side?: 'start' | 'end'
}) {
  const element = useRef<HTMLDivElement | null>(null)
  const reset = useRef(onReset)
  reset.current = onReset

  // The panel library hit-tests beside the divider too, so observe the whole hit area.
  useEffect(() => {
    if (disabled) return
    let press: { id: number; x: number; y: number; moved: boolean } | null = null
    const down = (event: PointerEvent) => {
      const rect = element.current?.getBoundingClientRect()
      if (event.button !== 0 || !rect?.height || event.clientY < rect.top || event.clientY > rect.bottom) return
      if (Math.abs(event.clientX - (rect.left + rect.width / 2)) <= HIT_SIZE / 2) {
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      }
    }
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_TOLERANCE) press.moved = true
    }
    const up = (event: PointerEvent) => {
      if (press?.id !== event.pointerId) return
      move(event)
      if (!press.moved) reset.current()
      press = null
      // Pointer focus must not hide the grip on the next hover; keyboard focus stays visible.
      requestAnimationFrame(() => element.current?.blur())
    }
    const cancel = () => { press = null }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
    }
  }, [disabled])

  return (
    <ResizableHandle
      {...props}
      disabled={disabled}
      elementRef={element}
      disableDoubleClick
      className={cn(
        "z-10 after:w-6 before:pointer-events-none before:absolute before:top-1/2 before:h-8 before:w-1 before:-translate-y-1/2 before:rounded-[6px] before:bg-muted-foreground/50 before:opacity-0 before:transition-opacity before:duration-150 before:content-[''] motion-reduce:before:transition-none",
        side === 'start' ? 'before:-left-2.5' : 'before:left-[7px]',
        'data-[separator=active]:before:bg-muted-foreground data-[separator=active]:before:opacity-100 data-[separator=hover]:before:opacity-100 focus-visible:before:opacity-100',
        className,
      )}
    />
  )
}
