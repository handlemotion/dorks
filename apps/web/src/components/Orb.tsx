import { useEffect, useState, type CSSProperties } from 'react'

/**
 * Ported from @aicss/react (MIT, https://www.aicss.dev), variant "M2" of the Orb: eight dots that open from a point into a ring and
 * close again while the whole thing turns. The component, its geometry (28px stage scaled by --orb-k, 3px dots, radius 1.5 -> 7),
 * timings and easings are aicss's, written as Tailwind utilities; the keyframes live in styles/theme.css.
 *
 * Differences from aicss: only this variant, no pill form, and a `working` switch. Every dot position is multiplied by
 * --orb-spread, so when `working` turns off the ring contracts to a single dot (a 4px dot, regardless of `size`) instead of
 * snapping, and the animation is paused once it has settled.
 */

/** The stage the geometry is tuned on; --orb-k scales it to `size`. */
const STAGE = 28
const MORPH_N = 8
const RING_R = 7
const CENTER_R = 1.5
/** Edge length of the dot a resting orb collapses to, in px. */
const REST_DOT = 4
/** How long the ring takes to contract into the dot (or open back up). */
const SETTLE_MS = 500

const DOTS = Array.from({ length: MORPH_N }, (_, i) => {
  const a = (i / MORPH_N) * Math.PI * 2 - Math.PI / 2
  const [cx, cy] = [Math.cos(a), Math.sin(a)]
  // M2 poses: centre, ring, centre, ring.
  const style: Record<string, string> = {}
  ;[CENTER_R, RING_R, CENTER_R, RING_R].forEach((r, k) => {
    style[`--m-${k + 1}x`] = `${(cx * r).toFixed(1)}px`
    style[`--m-${k + 1}y`] = `${(cy * r).toFixed(1)}px`
  })
  return { key: i, style: style as CSSProperties }
})

export function Orb({
  working = true,
  size = 24,
  label = working ? 'Working…' : 'Idle',
  className,
}: {
  /** Animate. When false the orb settles into a still dot. */
  working?: boolean
  /** Rendered edge length in px. The 28px geometry scales to fit. */
  size?: number
  /** Accessible label. */
  label?: string
  className?: string
}) {
  // Keep the animation running while it settles, then stop it so resting orbs cost nothing. Turning back on resumes it in
  // the same render, not an effect later.
  const [settled, setSettled] = useState(!working)
  if (working && settled) setSettled(false)
  useEffect(() => {
    if (working) return
    const t = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(t)
  }, [working])
  const paused = !working && settled

  return (
    <span
      className={`group/orb inline-flex items-center align-middle ${className ?? ''}`}
      data-paused={paused ? '' : undefined}
      // One source for the settle time: the spread transition below, the pause timer, and any color transition a parent adds.
      style={{ '--orb-settle': `${SETTLE_MS}ms` } as CSSProperties}
    >
      <span
        role="img"
        aria-label={label}
        className="relative block flex-none overflow-hidden [contain:strict]"
        style={{ width: size, height: size, '--orb-k': size / STAGE, '--orb-rest-dot': `${REST_DOT / (size / STAGE)}px` } as CSSProperties}
      >
        <span
          data-idle={working ? undefined : ''}
          className="absolute inset-0 [--orb-spread:1] [transform:scale(var(--orb-k,1))] animate-orb-twist transition-[--orb-spread] duration-(--orb-settle) ease-[cubic-bezier(0.4,0,0.2,1)] data-[idle]:[--orb-spread:0] group-data-[paused]/orb:[animation-play-state:paused] motion-reduce:animate-none"
        >
          {DOTS.map((d) => (
            <span
              key={d.key}
              style={d.style}
              className="absolute top-1/2 left-1/2 animate-orb-morph rounded-full bg-current [--orb-d:calc(3px_+_(var(--orb-rest-dot)_-_3px)_*_(1_-_var(--orb-spread)))] [width:var(--orb-d)] [height:var(--orb-d)] [margin:calc(var(--orb-d)/-2)_0_0_calc(var(--orb-d)/-2)] [transform:translate(calc(var(--m-1x)_*_var(--orb-spread)),calc(var(--m-1y)_*_var(--orb-spread)))] group-data-[paused]/orb:[animation-play-state:paused] motion-reduce:animate-none"
            />
          ))}
        </span>
      </span>
    </span>
  )
}
