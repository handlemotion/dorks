import type { Pointer } from './useOverlay'

// Rulers around a running preview, design-tool style: a horizontal one along the top of the preview area and a vertical one down its
// left, in the margin outside the page, numbered in the page's own pixels (the page is drawn scaled) with 0 at the page's top-left
// corner. Guides run through the pointer, and the element under it is outlined with its size and its extent marked on both rulers.
// Everything is drawn over the area and lets every event through to the page.

export const RULER = 20
const GAP = 4
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
          className="fill-brand/15"
          {...(horizontal ? { x: at(span[0]), y: 0, width: (span[1] - span[0]) * scale, height: RULER } : { x: 0, y: at(span[0]), width: RULER, height: (span[1] - span[0]) * scale })}
        />
      )}
      {marks.map((v) => {
        const p = at(v) + 0.5
        const long = v % major === 0
        const len = long ? 8 : 4
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
            <text key={v} x={at(v) + 3} y={13} className="fill-current text-xs tabular-nums">
              {v}
            </text>
          ) : (
            <text key={v} x={13} y={at(v) - 3} transform={`rotate(-90 13 ${at(v) - 3})`} className="fill-current text-xs tabular-nums">
              {v}
            </text>
          ),
        )}
      {pointer !== null &&
        (horizontal ? <line x1={at(pointer)} x2={at(pointer)} y1={0} y2={RULER} className="stroke-brand" /> : <line y1={at(pointer)} y2={at(pointer)} x1={0} x2={RULER} className="stroke-brand" />)}
    </svg>
  )
}

/**
 * Drawn in the preview area (the box the page is centred in): the rulers sit in its margin, `RULER + GAP` pixels outside it on the
 * top and the left, so the area needs at least that much room around it.
 */
export function Rulers({ on, view, area, pointer }: { on: boolean; view: View; area: { width: number; height: number }; pointer: Pointer | null }) {
  if (!on) return null
  const box = pointer?.box ?? null
  const s = view.scale
  const out = RULER + GAP
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {pointer && (
        <>
          <div className="absolute w-px bg-brand/40" style={{ left: view.left + pointer.x * s, top: -GAP, height: area.height + GAP }} />
          <div className="absolute h-px bg-brand/40" style={{ top: view.top + pointer.y * s, left: -GAP, width: area.width + GAP }} />
        </>
      )}
      {box && (
        <div className="absolute border border-dashed border-brand" style={{ left: view.left + box.x * s, top: view.top + box.y * s, width: box.width * s, height: box.height * s }}>
          <span
            className={`absolute left-0 rounded-(--control-radius) ${box.y * s < 28 ? 'top-full mt-1' : 'bottom-full mb-1'} bg-brand px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white tabular-nums`}
          >
            {pointer?.label ? `${pointer.label} ` : ''}
            {Math.round(box.width)} × {Math.round(box.height)}
          </span>
        </div>
      )}
      <div className="absolute overflow-hidden" style={{ left: 0, top: -out, width: area.width, height: RULER }}>
        <Ruler length={area.width} origin={view.left} scale={s} along="x" pointer={pointer?.x ?? null} span={box ? [box.x, box.x + box.width] : null} />
      </div>
      <div className="absolute overflow-hidden" style={{ left: -out, top: 0, width: RULER, height: area.height }}>
        <Ruler length={area.height} origin={view.top} scale={s} along="y" pointer={pointer?.y ?? null} span={box ? [box.y, box.y + box.height] : null} />
      </div>
      {pointer && (
        <span
          className="absolute rounded-(--control-radius) bg-foreground px-1.5 py-0.5 font-mono text-xs text-background tabular-nums"
          style={{ left: view.left + pointer.x * s + 8, top: view.top + pointer.y * s + 8 }}
        >
          {Math.round(pointer.x)}, {Math.round(pointer.y)}
        </span>
      )}
    </div>
  )
}
