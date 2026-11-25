import { useRef } from 'react'
import { useSize } from './PreviewMarks'
import type { Pointer } from './useOverlay'

// Rulers around a running preview, design-tool style: a horizontal one along the top of the preview area and a vertical one down its
// left, in the margin outside the page, numbered in the page's own pixels (the page is drawn scaled) with 0 at the page's top-left
// corner. Guides run through the pointer, and the element under it is outlined with its size and its extent marked on both rulers.
// Everything is drawn over the area and lets every event through to the page.

export const RULER = 14
/** The page's margin in the pane; with rulers on, the top and left one starts after them. */
export const MARGIN = 16
const STEPS = [2, 5, 10, 20, 50, 100, 200, 500, 1000]

/** Ticks every `minor` page pixels, numbers every `major`, spaced to stay readable at `scale`. */
function ticks(scale: number) {
  const minor = STEPS.find((s) => s * scale >= 6) ?? 1000
  const major = STEPS.find((s) => s >= minor * 5 && s * scale >= 56) ?? minor * 10
  return { minor, major }
}

type View = { left: number; top: number; width: number; height: number; scale: number }

/** One ruler: `length` screen pixels long, its page 0 at `origin` (screen pixels from its start). */
function Ruler({ length, origin, scale, along, pointer, span }: { length: number; origin: number; scale: number; along: 'x' | 'y'; pointer: number | null; span: [number, number] | null }) {
  const { minor, major } = ticks(scale)
  const from = Math.ceil(-origin / scale / minor) * minor
  const marks: number[] = []
  for (let v = from; origin + v * scale <= length; v += minor) marks.push(v)
  const horizontal = along === 'x'
  const at = (v: number) => origin + v * scale
  return (
    <svg aria-hidden className="absolute inset-0 size-full text-muted-foreground">
      {span && (
        <rect
          className="fill-red-500/15"
          {...(horizontal ? { x: at(span[0]), y: 0, width: (span[1] - span[0]) * scale, height: RULER } : { x: 0, y: at(span[0]), width: RULER, height: (span[1] - span[0]) * scale })}
        />
      )}
      {marks.map((v) => {
        const p = at(v) + 0.5
        const long = v % major === 0
        const len = long ? 6 : 3
        return horizontal ? (
          <line key={v} x1={p} x2={p} y1={RULER - len} y2={RULER} stroke="currentColor" strokeOpacity={long ? 0.6 : 0.3} />
        ) : (
          <line key={v} y1={p} y2={p} x1={RULER - len} x2={RULER} stroke="currentColor" strokeOpacity={long ? 0.6 : 0.3} />
        )
      })}
      {marks
        .filter((v) => v % major === 0)
        .map((v) =>
          horizontal ? (
            <text key={v} x={at(v) + 3} y={9} className="fill-current tabular-nums" fontSize={9}>
              {v}
            </text>
          ) : (
            <text key={v} x={9} y={at(v) - 3} transform={`rotate(-90 9 ${at(v) - 3})`} className="fill-current tabular-nums" fontSize={9}>
              {v}
            </text>
          ),
        )}
      {pointer !== null &&
        (horizontal ? (
          <line x1={at(pointer)} x2={at(pointer)} y1={0} y2={RULER} className="stroke-red-500" />
        ) : (
          <line y1={at(pointer)} y2={at(pointer)} x1={0} x2={RULER} className="stroke-red-500" />
        ))}
    </svg>
  )
}

/**
 * Drawn over the whole preview pane (above the toolbar): a horizontal ruler along its top edge and a vertical one down its left, full
 * length, numbered in the page's own pixels from the page's top-left corner, which sits `offset` into the pane. The page itself is laid
 * out in the room to the right of and below them (`RULER_ROOM`).
 */
export function Rulers({ on, view, offset, pointer }: { on: boolean; view: View; offset: { x: number; y: number }; pointer: Pointer | null }) {
  const pane = useRef<HTMLDivElement>(null)
  const size = useSize(pane)
  const box = pointer?.box ?? null
  const s = view.scale
  const x0 = offset.x + view.left
  const y0 = offset.y + view.top
  return (
    <div ref={pane} aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 bottom-12 ${on ? '' : 'hidden'}`}>
      {pointer && (
        <>
          <div className="absolute inset-y-0 w-px bg-red-500/40" style={{ left: x0 + pointer.x * s }} />
          <div className="absolute inset-x-0 h-px bg-red-500/40" style={{ top: y0 + pointer.y * s }} />
        </>
      )}
      {box && (
        <div className="absolute border border-dashed border-red-500" style={{ left: x0 + box.x * s, top: y0 + box.y * s, width: box.width * s, height: box.height * s }}>
          <span
            className={`absolute left-0 rounded-(--control-radius) ${box.y * s < 28 ? 'top-full mt-1' : 'bottom-full mb-1'} bg-red-500 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white tabular-nums`}
          >
            {pointer?.label ? `${pointer.label} ` : ''}
            {Math.round(box.width)} × {Math.round(box.height)}
          </span>
        </div>
      )}
      <div className="absolute top-0 right-0 overflow-hidden border-b bg-background" style={{ left: RULER, height: RULER }}>
        <Ruler length={size.width - RULER} origin={x0 - RULER} scale={s} along="x" pointer={pointer?.x ?? null} span={box ? [box.x, box.x + box.width] : null} />
      </div>
      <div className="absolute bottom-0 left-0 overflow-hidden border-r bg-background" style={{ top: RULER, width: RULER }}>
        <Ruler length={size.height - RULER} origin={y0 - RULER} scale={s} along="y" pointer={pointer?.y ?? null} span={box ? [box.y, box.y + box.height] : null} />
      </div>
      <div className="absolute top-0 left-0 border-r border-b bg-background" style={{ width: RULER, height: RULER }} />
      {pointer && (
        <span
          className="absolute rounded-(--control-radius) bg-foreground px-1.5 py-0.5 font-mono text-xs text-background tabular-nums"
          style={{ left: x0 + pointer.x * s + 8, top: y0 + pointer.y * s + 8 }}
        >
          {Math.round(pointer.x)}, {Math.round(pointer.y)}
        </span>
      )}
    </div>
  )
}
