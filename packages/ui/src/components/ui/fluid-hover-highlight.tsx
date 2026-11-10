"use client"

// The one hover fill a list renders, an absolutely positioned box that springs between the rows `useFluidHoverList` measures. The container must be `relative`.
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react"
import { cn } from "cn"
import type { ItemRect } from "#hooks/use-fluid-hover-list"

/** Short and critically damped: it lands exactly, with no overshoot. */
const spring = { type: "spring" as const, duration: 0.08, bounce: 0 }
const exit = { duration: 0.06 }
const fade: Transition = { duration: 0.08 }
const snap: Transition = { duration: 0 }

const toTarget = (rect: ItemRect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })

export function FluidHoverHighlight({ rect, session, from, className, style }: {
  /** The rect to sit on, in the container's coordinates; `null` hides it (it fades out). */
  rect: ItemRect | null
  /** Increments when the pointer enters the container, so the highlight fades in where it lands instead of sliding from the last row. */
  session: number
  /** Where a fresh session fades in from. Defaults to the rect itself. */
  from?: ItemRect | null
  className?: string
  style?: { borderRadius?: string }
}) {
  // Reduced motion keeps the fade and drops the travel.
  const reduceMotion = useReducedMotion() ?? false
  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          key={session}
          data-slot="fluid-hover-highlight"
          className={cn("pointer-events-none absolute top-0 left-0", className)}
          style={style}
          initial={{ opacity: 0, ...toTarget(from ?? rect) }}
          animate={{ opacity: 1, ...toTarget(rect) }}
          exit={{ opacity: 0, transition: exit }}
          transition={{ ...(reduceMotion ? snap : spring), opacity: fade }}
        />
      )}
    </AnimatePresence>
  )
}
