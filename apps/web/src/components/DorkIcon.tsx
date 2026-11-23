import { useId } from 'react'
import type { DorkState } from '@dorks/shared'

export type DorkIconState = 'working' | 'awake' | 'asleep' | 'error'

/** The three stacked lobes that form the dork silhouette (200×200 coordinate space). */
const SHAPE_PATH =
  'M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40'

/** Maps a dork's lifecycle state (and connection state when relevant) to the icon's visual state. */
export function dorkIconState(state: DorkState | undefined, opts?: { working?: boolean; live?: string }): DorkIconState {
  if (opts?.live === 'offline' || opts?.live === 'connecting') return 'working'
  switch (state) {
    case 'creating':
    case 'waking':
    case 'working':
      return 'working'
    case 'idle':
      return 'awake'
    case 'sleeping':
      return 'asleep'
    case 'error':
      return 'error'
    default:
      return opts?.working ? 'working' : 'asleep'
  }
}

/**
 * The dork status mark: three stacked lobes.
 * - `working`: cyan → blue → violet gradient with animated lobes and flowing colour.
 * - `awake`: the same coloured gradient, still.
 * - `asleep`: the same shape in muted grey, still.
 * - `error`: the same shape in destructive red, still.
 */
export function DorkIcon({
  state,
  size = 14,
  label,
  className,
}: {
  state: DorkIconState
  /** Rendered edge length in px. */
  size?: number
  /** Accessible label. Omit when decorative (sets `aria-hidden`). */
  label?: string
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const maskId = `dork-mask-${uid}`
  const gradId = `dork-grad-${uid}`
  const colored = state === 'working' || state === 'awake'
  const tone = state === 'asleep' ? 'text-muted-foreground/45' : state === 'error' ? 'text-destructive' : ''

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="-3.093 -3.093 206.186 206.186"
      width={size}
      height={size}
      data-dork-icon={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`shrink-0 ${tone} ${className ?? ''}`}
    >
      {colored && (
        <defs>
          <linearGradient id={gradId} x1="100" y1={state === 'working' ? -40 : 0} x2="100" y2={state === 'working' ? 240 : 200} gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00f0ff" />
            <stop offset="22%" stopColor="#08a8ff" />
            <stop offset="48%" stopColor="#0e6fff" />
            <stop offset="78%" stopColor="#6a62ff" />
            <stop offset="100%" stopColor="#8f5bff" />
          </linearGradient>
          {state === 'working' && (
            <mask id={maskId} width="200" height="220" x="0" y="-10" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
              <ellipse cx="100" cy="40" rx="80" ry="40" fill="#fff" className="dork-lobe dork-lobe-1" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-lobe dork-lobe-2" />
              <ellipse cx="100" cy="160" rx="80" ry="40" fill="#fff" className="dork-lobe dork-lobe-3" />
            </mask>
          )}
        </defs>
      )}
      {state === 'working' ? (
        <g mask={`url(#${maskId})`}>
          <rect x="0" y="-40" width="200" height="280" fill={`url(#${gradId})`} className="dork-gradient-drift" />
        </g>
      ) : (
        <path d={SHAPE_PATH} fill={colored ? `url(#${gradId})` : 'currentColor'} />
      )}
    </svg>
  )
}
