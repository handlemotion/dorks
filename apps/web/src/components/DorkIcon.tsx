import { useId } from 'react'
import type { DorkState } from '@dorks/shared'

export type DorkIconState = 'working' | 'unread' | 'awake' | 'asleep' | 'attention' | 'error'

/** The three stacked lobes that form the dork silhouette (200×200 coordinate space). */
const SHAPE_PATH =
  'M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40'

/** Working: the foreground colour (so it follows the theme) at these opacities, light at the top to strong at the bottom. */
const GREY_STOPS = [
  ['0%', '0.22'],
  ['30%', '0.38'],
  ['60%', '0.55'],
  ['100%', '0.72'],
] as const

/** Unread: a finished turn the owner has not opened yet. */
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

/** Attention: the dork waits on the owner's permission or answer. */
const YELLOW_STOPS = [
  ['0%', '#fff066'],
  ['24%', '#ffd426'],
  ['52%', '#ffb000'],
  ['82%', '#ff8800'],
  ['100%', '#ff6b00'],
] as const

const TONE: Partial<Record<DorkIconState, string>> = { asleep: 'text-muted-foreground/70', error: 'text-destructive' }

const GREY = { stops: GREY_STOPS, grey: true, tone: 'text-foreground' }
const PALETTE: Partial<Record<DorkIconState, { stops: readonly (readonly [string, string])[]; grey: boolean; tone: string }>> = {
  working: GREY,
  awake: GREY,
  unread: { stops: BLUE_STOPS, grey: false, tone: '' },
  attention: { stops: YELLOW_STOPS, grey: false, tone: '' },
}

/** The gradient for a state; grey stops are opacities of the foreground colour (`grey`), which `tone` sets. */
function palette(state: DorkIconState, nerd?: boolean) {
  if (nerd && state === 'working') return { stops: GREEN_STOPS, grey: false, tone: '' }
  return PALETTE[state] ?? { stops: GREY_STOPS, grey: false, tone: TONE[state] ?? '' }
}

/** Asleep: the shape's outline, an inside stroke about 1.2px wide at any size (twice that width, clipped to the shape). */
function DorkOutline({ id, size }: { id: string; size: number }) {
  return (
    <>
      <defs>
        <clipPath id={id}>
          <path d={SHAPE_PATH} />
        </clipPath>
      </defs>
      <path d={SHAPE_PATH} fill="none" stroke="currentColor" strokeWidth={(2.4 * 206.186) / size} clipPath={`url(#${id})`} />
    </>
  )
}

/**
 * Maps a dork's lifecycle state (and connection, attention and unread state when relevant) to the icon's visual state. Attention
 * comes first, then movement; an unread finished turn shows on an awake or sleeping dork alike.
 */
export function dorkIconState(state: DorkState | undefined, opts?: { working?: boolean; live?: string; attention?: boolean; unread?: boolean }): DorkIconState {
  if (opts?.attention) return 'attention'
  if (opts?.live === 'offline' || opts?.live === 'connecting') return 'working'
  if (opts?.unread && (state === 'idle' || state === 'sleeping')) return 'unread'
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
 * - `working`: a grey gradient (the foreground colour at varying strength) with animated flaps and flowing colour.
 * - `unread`: the cyan → blue → violet gradient, still: the agent finished a turn the owner has not opened yet.
 * - `attention`: yellow → amber gradient with animated flaps when waiting on the owner (computer access, build approval, prompts).
 *   Yellow means only this.
 * - `awake`: the working grey, still: the turn is over and read, and the dork waits for the next message before it sleeps.
 * - `asleep`: the shape's outline only, in muted grey, no fill, still.
 * - `error`: the same shape in destructive red, still.
 * A nerd (`nerd`) is green where a session is grey (working); every other state looks the same as any session's.
 * `still` draws the working colours without motion (the nerd mark in the mode menu).
 */
export function DorkIcon({
  state,
  size = 14,
  label,
  className,
  nerd,
  still,
}: {
  state: DorkIconState
  /** A nerd session (docs/modes.md): green instead of the working grey. */
  nerd?: boolean
  /** No motion: the working colours as a still mark. */
  still?: boolean
  /** Rendered edge length in px. */
  size?: number
  /** Accessible label. Omit when decorative (sets `aria-hidden`). */
  label?: string
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const maskId = `dork-mask-${uid}`
  const gradId = `dork-grad-${uid}`
  const animated = !still && (state === 'working' || state === 'attention')
  const colored = animated || state === 'awake' || state === 'unread' || (still && state === 'working')
  const { stops, grey, tone } = palette(state, nerd)

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
              <stop key={offset} offset={offset} stopColor={grey ? 'currentColor' : color} stopOpacity={grey ? Number(color) : undefined} />
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
      ) : state === 'asleep' ? (
        <DorkOutline id={`dork-clip-${uid}`} size={size} />
      ) : (
        <path d={SHAPE_PATH} fill={colored ? `url(#${gradId})` : 'currentColor'} />
      )}
    </svg>
  )
}
