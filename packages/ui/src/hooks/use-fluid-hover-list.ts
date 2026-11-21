"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/** A row's box in the container's padding-box coordinates. */
export interface ItemRect {
  top: number
  height: number
  left: number
  width: number
}

/** The lit row carries this attribute. */
export const ACTIVE_ATTR = "data-fluid-hover-active"

// ---------------------------------------------------------------------------
// The fluid hover for lists whose rows a primitive owns: menus, context menus,
// selects, command palettes, and plain link lists. The container finds its
// rows by selector instead of asking each row to register, so every consumer
// of a primitive inherits the effect without touching its items.
//
//   const hover = useFluidHoverList({ itemSelector: "[role='menuitem']" });
//   <div className="relative" {...hover.containerProps}>
//     <FluidHoverHighlight {...hover.highlightProps} />
//     {rows}
//   </div>
//
// Unlike `useFluidHover`, rects are read from the live layout on every pick,
// so rows inside a nested scroller (a menu's scrolling radio group) stay
// correct, and the primitive's own highlighted row (keyboard navigation, a
// select's preselected option, a palette's first result) drives the highlight
// whenever the pointer is not.
// ---------------------------------------------------------------------------

export interface UseFluidHoverListOptions {
  /** Matches the rows inside the container. */
  itemSelector: string
  /** Matches the row the primitive itself highlights (`[data-highlighted]`
   *  for Base UI, `[data-selected='true']` for cmdk). Without it only the
   *  pointer lights rows. */
  highlightedSelector?: string
  /** Matches a row that stays lit when neither the pointer nor the primitive
   *  lights one (`[data-popup-open]`: a menu's open submenu trigger, while
   *  the pointer is in the submenu). */
  heldSelector?: string
  /** How far, in pixels, the pointer may sit outside a row and still light it
   *  (the gaps, the padding, a separator). Beyond that nothing is lit, so a
   *  header or an empty state never promises a row. Defaults to 12, which
   *  bridges a menu separator's margins. */
  maxDistance?: number
}

export interface UseFluidHoverListReturn {
  /** The lit row, for styling the highlight by row (a destructive item). */
  activeElement: HTMLElement | null
  /** Spread onto `FluidHoverHighlight`. */
  highlightProps: { rect: ItemRect | null; session: number; style?: { borderRadius: string } }
  /** Spread onto the container, which must be `relative`. The ref is a
   *  callback, so a container that mounts after the hook (a portalled popup)
   *  is still observed. */
  containerProps: {
    ref: (element: HTMLElement | null) => void
    onMouseMoveCapture: (event: React.MouseEvent) => void
    onMouseEnter: (event: React.MouseEvent) => void
    onMouseLeave: (event: React.MouseEvent) => void
    onClick: (event: React.MouseEvent) => void
  }
}

/** Rows the pointer never lights: disabled (Base UI sets an empty
 *  `data-disabled`, cmdk sets `"false"` on enabled rows) or opted out. */
const SKIP_SELECTOR = "[data-disabled]:not([data-disabled='false']), [aria-disabled='true'], [data-fluid-hover-skip]"

/** Controls between the rows keep their own clicks. */
const CONTROL_SELECTOR = "input, textarea, select, button, a, summary, [contenteditable], [role='textbox'], [role='searchbox'], [role='button']"

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** The row's viewport box, clipped by any scroller from it up to and
 *  including the container. `null` when the row has no box or is scrolled
 *  out of view. */
function visibleBounds(element: HTMLElement, container: HTMLElement): Bounds | null {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  let { left, top, right, bottom } = rect
  for (let ancestor: HTMLElement | null = element.parentElement; ancestor; ancestor = ancestor === container ? null : ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.overflowX === "visible" && style.overflowY === "visible") continue
    const clip = ancestor.getBoundingClientRect()
    left = Math.max(left, clip.left)
    top = Math.max(top, clip.top)
    right = Math.min(right, clip.right)
    bottom = Math.min(bottom, clip.bottom)
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null
}

/** Viewport bounds in the container's padding-box coordinates, the space an
 *  absolutely positioned child is laid out in. Factors out an ancestor
 *  `scale` (a dialog mid zoom-in). */
function toContainerRect(bounds: Bounds, container: HTMLElement): ItemRect {
  const box = container.getBoundingClientRect()
  const scaleX = container.offsetWidth > 0 ? box.width / container.offsetWidth : 1
  const scaleY = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1
  return {
    left: (bounds.left - box.left) / scaleX - container.clientLeft + container.scrollLeft,
    top: (bounds.top - box.top) / scaleY - container.clientTop + container.scrollTop,
    width: (bounds.right - bounds.left) / scaleX,
    height: (bounds.bottom - bounds.top) / scaleY,
  }
}

/** Whether the point lies strictly inside the container's viewport box. */
function isInside(container: HTMLElement, point: { clientX: number; clientY: number }) {
  const box = container.getBoundingClientRect()
  return point.clientX > box.left && point.clientX < box.right && point.clientY > box.top && point.clientY < box.bottom
}

function rowsOf(container: HTMLElement, itemSelector: string) {
  return Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
}

function contains(bounds: Bounds | null, point: { x: number; y: number }) {
  return bounds !== null && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom
}

/** The skipped row (disabled, opted out) under the pointer, if any. */
function skippedRowUnder(container: HTMLElement, itemSelector: string, point: { x: number; y: number }): HTMLElement | null {
  return rowsOf(container, itemSelector).find((row) => row.matches(SKIP_SELECTOR) && contains(visibleBounds(row, container), point)) ?? null
}

/** The row under the pointer, else the nearest within `maxDistance`. */
function pickRow(container: HTMLElement, itemSelector: string, point: { x: number; y: number }, maxDistance: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestDistance = Infinity
  for (const row of rowsOf(container, itemSelector)) {
    if (row.matches(SKIP_SELECTOR)) continue
    const bounds = visibleBounds(row, container)
    if (!bounds) continue
    const dx = Math.max(bounds.left - point.x, 0, point.x - bounds.right)
    const dy = Math.max(bounds.top - point.y, 0, point.y - bounds.bottom)
    const distance = Math.hypot(dx, dy)
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
      if (distance === 0) break
    }
  }
  return bestDistance <= maxDistance ? best : null
}

interface LitRow {
  element: HTMLElement | null
  /** Lit by the pointer's position, so a click in a gap may land on it. */
  picked: boolean
  rect: ItemRect | null
  radius: string | undefined
}

const NOTHING_LIT: LitRow = { element: null, picked: false, rect: null, radius: undefined }

function sameRect(a: ItemRect | null, b: ItemRect | null) {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

export function useFluidHoverList({ itemSelector, highlightedSelector, heldSelector, maxDistance = 12 }: UseFluidHoverListOptions): UseFluidHoverListReturn {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  const ref = useCallback((element: HTMLElement | null) => {
    containerRef.current = element
    setContainer(element)
  }, [])
  const [lit, setLit] = useState<LitRow>(NOTHING_LIT)
  const [session, setSession] = useState(0)
  const litRef = useRef<LitRow>(NOTHING_LIT)
  // While the pointer is inside it decides; otherwise (it left, or a key
  // moved the primitive's highlight) the primitive's highlighted row does.
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  // The primitive stopped the container taking pointer events (Base UI does
  // while a submenu is open, so the path to it crosses no other row): the
  // pointer is still over the container, which only hears it again once
  // events come back.
  const blockedRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  const highlightedRow = useCallback(() => {
    const container = containerRef.current
    if (!container || !highlightedSelector) return null
    return rowsOf(container, itemSelector).find((row) => row.matches(highlightedSelector)) ?? null
  }, [containerRef, highlightedSelector, itemSelector])

  const refresh = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const pointer = pointerRef.current
    // A pointer resting on a disabled row lights nothing: not its neighbour,
    // not the primitive's highlight (Base UI highlights disabled rows too).
    const onSkipped = pointer ? skippedRowUnder(container, itemSelector, pointer) : null
    // Away from every row the primitive's own highlight still shows: a
    // palette keeps its selected result lit, which is what Enter runs.
    const picked = pointer && !onSkipped ? pickRow(container, itemSelector, pointer, maxDistance) : null
    const held = heldSelector ? (rowsOf(container, itemSelector).find((row) => row.matches(heldSelector)) ?? null) : null
    const element = onSkipped ? null : (picked ?? highlightedRow() ?? held)
    const bounds = element ? visibleBounds(element, container) : null
    const next: LitRow =
      element && bounds
        ? {
            element,
            picked: picked !== null,
            rect: toContainerRect(bounds, container),
            radius: getComputedStyle(element).borderRadius,
          }
        : NOTHING_LIT
    const previous = litRef.current
    if (previous.element === next.element && previous.picked === next.picked && previous.radius === next.radius && sameRect(previous.rect, next.rect)) {
      return
    }
    litRef.current = next
    setLit(next)
  }, [containerRef, heldSelector, highlightedRow, itemSelector, maxDistance])

  const scheduleRefresh = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      refresh()
    })
  }, [refresh])

  // Rows come and go (a filtered palette, a loading menu), scroll, resize,
  // and the primitive moves its own highlight on keys: each re-picks.
  useEffect(() => {
    if (!container) return
    scheduleRefresh()
    const mutations = new MutationObserver((records) => {
      const keyboardMoved =
        highlightedSelector !== undefined &&
        records.some((record) => record.type === "attributes" && record.target instanceof HTMLElement && record.target.matches(highlightedSelector) && record.target.matches(itemSelector))
      // A key moved the primitive's highlight: it leads until the pointer
      // moves again. A pointer-driven highlight lands on the row under the
      // pointer, which the pointer pick agrees with (or, for a disabled row,
      // deliberately leaves unlit), so only keys change it.
      if (keyboardMoved) {
        const row = highlightedRow()
        const pointer = pointerRef.current
        const underPointer = row !== null && pointer !== null && contains(visibleBounds(row, container), pointer)
        if (row && row !== litRef.current.element && !underPointer) pointerRef.current = null
      }
      scheduleRefresh()
    })
    mutations.observe(container, {
      attributes: true,
      attributeFilter: ["data-highlighted", "data-selected", "data-disabled", "aria-disabled", "data-popup-open"],
      childList: true,
      subtree: true,
    })
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleRefresh)
    resize?.observe(container)
    container.addEventListener("scroll", scheduleRefresh, { capture: true, passive: true })
    return () => {
      mutations.disconnect()
      resize?.disconnect()
      container.removeEventListener("scroll", scheduleRefresh, { capture: true })
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [container, highlightedRow, highlightedSelector, scheduleRefresh])

  // While blocked the container hears nothing, so the window tells it when
  // the pointer really leaves (into the submenu, or away).
  useEffect(() => {
    if (!container) return
    const onPointerMove = (event: PointerEvent) => {
      if (!blockedRef.current || isInside(container, event)) return
      blockedRef.current = false
      pointerRef.current = null
      scheduleRefresh()
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    return () => window.removeEventListener("pointermove", onPointerMove)
  }, [container, scheduleRefresh])

  // The lit row carries `data-fluid-hover-active`, like `useFluidHover`'s.
  useEffect(() => {
    const element = lit.element
    element?.setAttribute(ACTIVE_ATTR, "")
    return () => element?.removeAttribute(ACTIVE_ATTR)
  }, [lit.element])

  // Heard on the way down, so a control inside a row that stops its own
  // moves (an ⓘ tooltip button) cannot hide the pointer.
  const onMouseMoveCapture = useCallback(
    (event: React.MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      scheduleRefresh()
    },
    [scheduleRefresh],
  )

  // Entering picks from the entry point at once: a pointer that comes back
  // without moving (an overlay the primitive drew over it went away) still
  // lights the row it rests on. A fresh session fades in only when nothing is
  // lit: from a lit row (events back after a block, a held submenu trigger)
  // the highlight slides on.
  const onMouseEnter = useCallback(
    (event: React.MouseEvent) => {
      if (litRef.current.element === null) setSession((value) => value + 1)
      blockedRef.current = false
      pointerRef.current = { x: event.clientX, y: event.clientY }
      scheduleRefresh()
    },
    [scheduleRefresh],
  )

  // A leave that lands inside the container is the primitive blocking
  // events, not the pointer leaving: the lit row holds.
  const onMouseLeave = useCallback(
    (event: React.MouseEvent) => {
      const container = containerRef.current
      if (container && isInside(container, event)) {
        blockedRef.current = true
        return
      }
      pointerRef.current = null
      scheduleRefresh()
    },
    [containerRef, scheduleRefresh],
  )

  // A click in a gap lands on the lit row, so what is lit is what a click
  // hits. Clicks inside a row or on a control between rows are theirs.
  const onClick = useCallback(
    (event: React.MouseEvent) => {
      const container = containerRef.current
      const target = event.target as Element | null
      if (!container || !target?.isConnected || !pointerRef.current) return
      if (target.closest(itemSelector) || target.closest(CONTROL_SELECTOR)) return
      const { element, picked } = litRef.current
      if (!element || !picked || element.matches(SKIP_SELECTOR)) return
      element.click()
    },
    [containerRef, itemSelector],
  )

  return {
    activeElement: lit.element,
    highlightProps: {
      rect: lit.rect,
      session,
      style: lit.radius ? { borderRadius: lit.radius } : undefined,
    },
    containerProps: { ref, onMouseMoveCapture, onMouseEnter, onMouseLeave, onClick },
  }
}
