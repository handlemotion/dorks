import { useId } from 'react'
import type { DorkState } from '@dorks/shared'

export type DorkIconState = 'working' | 'unread' | 'awake' | 'asleep' | 'attention' | 'error'

/** The three stacked lobes that form the dork silhouette (200×200 coordinate space). */
const SHAPE_PATH =
  'M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40'

/** The fill for a state, one flat colour, never a gradient. Grey is the foreground colour (`tone`) at one opacity. */
type Fill = { color: string; opacity?: number; tone: string }

/** Working and awake: a light grey, the foreground colour at one opacity. */
const GREY: Fill = { color: 'currentColor', opacity: 0.32, tone: 'text-foreground' }
/** Unread: a finished turn the owner has not opened yet. */
const BLUE: Fill = { color: '#0e6fff', tone: '' }
/** A nerd's colour (docs/modes.md): the same mark in green in every state, so the sessions that run other sessions stand apart. */
const GREEN: Fill = { color: '#1fcc7a', tone: '' }
/** Attention: the dork waits on the owner's permission or answer. */
const YELLOW: Fill = { color: '#ffb000', tone: '' }

const TONE: Partial<Record<DorkIconState, string>> = { asleep: 'text-muted-foreground/70', error: 'text-destructive' }
const FILL: Partial<Record<DorkIconState, Fill>> = { working: GREY, awake: GREY, unread: BLUE, attention: YELLOW }

function fill(state: DorkIconState, nerd?: boolean): Fill {
  if (nerd) return GREEN
  return FILL[state] ?? { color: 'currentColor', tone: TONE[state] ?? '' }
}

/** Asleep: the shape's outline, an inside stroke about 0.9px wide at any size (twice that width, clipped to the shape). */
function DorkOutline({ id, size }: { id: string; size: number }) {
  return (
    <>
      <defs>
        <clipPath id={id}>
          <path d={SHAPE_PATH} />
        </clipPath>
      </defs>
      <path d={SHAPE_PATH} fill="none" stroke="currentColor" strokeWidth={(1.8 * 206.186) / size} clipPath={`url(#${id})`} />
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
 * The dork status mark: three stacked lobes, always one flat colour (no gradients).
 * - `working`: a flat light grey (the foreground colour at one strength) with animated flaps.
 * - `unread`: flat blue, still: the agent finished a turn the owner has not opened yet.
 * - `attention`: flat amber with animated flaps when waiting on the owner (computer access, build approval, prompts).
 *   Yellow means only this.
 * - `awake`: the working grey, still: the turn is over and read, and the dork waits for the next message before it sleeps.
 * - `asleep`: the shape's outline only, in muted grey, no fill, still.
 * - `error`: the same shape in destructive red, still.
 * A nerd (`nerd`) is always green: the same fill, flaps or outline as any session's state, in green instead of its colour.
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
  /** A nerd session (docs/modes.md): green in every state. */
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
  const animated = !still && (state === 'working' || state === 'attention')
  const { color, opacity, tone } = fill(state, nerd)

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
      style={nerd ? { color: GREEN.color } : undefined}
      className={`shrink-0 ${tone} ${className ?? ''}`}
    >
      {animated ? (
        <>
          <defs>
            <mask id={maskId} width="200" height="220" x="0" y="-10" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-1" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-2" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-3" />
              <ellipse cx="100" cy="100" rx="80" ry="40" fill="#fff" className="dork-flap dork-flap-4" />
            </mask>
          </defs>
          <rect x="0" y="-10" width="200" height="220" fill={color} fillOpacity={opacity} mask={`url(#${maskId})`} />
        </>
      ) : state === 'asleep' ? (
        <DorkOutline id={`dork-clip-${uid}`} size={size} />
      ) : (
        <path d={SHAPE_PATH} fill={color} fillOpacity={opacity} />
      )}
    </svg>
  )
}
