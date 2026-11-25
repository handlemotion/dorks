import { useId } from 'react'
import type { DorkState } from '@dorks/shared'

export type DorkIconState = 'working' | 'awake' | 'asleep' | 'attention' | 'error'

/** The three stacked lobes that form the dork silhouette (200×200 coordinate space). */
const SHAPE_PATH =
  'M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40'

const BLUE_STOPS = [
  ['0%', '#00f0ff'],
  ['22%', '#08a8ff'],
  ['48%', '#0e6fff'],
  ['78%', '#6a62ff'],
  ['100%', '#8f5bff'],
] as const

/** A nerd's colour (docs/modes.md): the same mark in green, so the sessions that run other sessions stand apart. */
const GREEN_STOPS = [
  ['0%', '#b4ff6a'],
  ['24%', '#5ee87a'],
  ['52%', '#1fcc7a'],
  ['82%', '#10a86a'],
  ['100%', '#0b8a5f'],
] as const

const YELLOW_STOPS = [
  ['0%', '#fff066'],
  ['24%', '#ffd426'],
  ['52%', '#ffb000'],
  ['82%', '#ff8800'],
  ['100%', '#ff6b00'],
] as const

/** Maps a dork's lifecycle state (and connection/attention state when relevant) to the icon's visual state. */
export function dorkIconState(state: DorkState | undefined, opts?: { working?: boolean; live?: string; attention?: boolean }): DorkIconState {
  if (opts?.attention) return 'attention'
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
 * - `working`: cyan → blue → violet gradient with animated flaps and flowing colour. Blue means the agent is actively working.
 * - `attention`: yellow → amber gradient with animated flaps when waiting on the owner (computer access, build approval, prompts).
 * - `awake`: the yellow → amber gradient, still: the turn is over and the dork waits for the next message before it sleeps.
 * - `asleep`: the same shape in muted grey, still.
 * - `error`: the same shape in destructive red, still.
 * A nerd (`nerd`) is green where a session is blue (working) or yellow (awake); it still turns yellow when it needs the owner.
 */
export function DorkIcon({
  state,
  size = 14,
  label,
  className,
  nerd,
}: {
  state: DorkIconState
  /** A nerd session (docs/modes.md): green instead of blue and the awake yellow. */
  nerd?: boolean
  /** Rendered edge length in px. */
  size?: number
  /** Accessible label. Omit when decorative (sets `aria-hidden`). */
  label?: string
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const maskId = `dork-mask-${uid}`
  const gradId = `dork-grad-${uid}`
  const animated = state === 'working' || state === 'attention'
  const colored = animated || state === 'awake'
  const stops = nerd && state !== 'attention' ? GREEN_STOPS : state === 'working' ? BLUE_STOPS : YELLOW_STOPS
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
          <linearGradient id={gradId} x1="100" y1={animated ? -40 : 0} x2="100" y2={animated ? 240 : 200} gradientUnits="userSpaceOnUse">
            {stops.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
          {animated && (
            <mask id={maskId} width="200" height="220" x="0" y="-10" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-1" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-2" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-3" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-4" />
            </mask>
          )}
        </defs>
      )}
      {animated ? (
        <g mask={`url(#${maskId})`}>
          <rect x="0" y="-40" width="200" height="280" fill={`url(#${gradId})`} className="dork-gradient-drift" />
        </g>
      ) : (
        <path d={SHAPE_PATH} fill={colored ? `url(#${gradId})` : 'currentColor'} />
      )}
    </svg>
  )
}
