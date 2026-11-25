import type { Pointer } from './useOverlay'

// Rulers over a running preview: a horizontal one along the top and a vertical one down the left, in the page's own pixels (the page
// is drawn scaled to fit), with guides through the pointer and the element under it outlined with its size, its extent marked on
// both rulers. Everything here is drawn over the page and lets every event through to it.

const BAND = 20
const STEPS = [2, 5, 10, 20, 50, 100, 200, 500, 1000]

/** Ticks every `minor` page pixels, numbers every `major`, spaced to stay readable at `scale`. */
function ticks(scale: number) {
  const minor = STEPS.find((s) => s * scale >= 6) ?? 1000
  const major = STEPS.find((s) => s >= minor * 5 && s * scale >= 56) ?? minor * 10
  return { minor, major }
}

function Ruler({ length, scale, along, pointer, span }: { length: number; scale: number; along: 'x' | 'y'; pointer: number | null; span: [number, number] | null }) {
  const { minor, major } = ticks(scale)
  const marks: number[] = []
  for (let v = 0; v <= length; v += minor) marks.push(v)
  const horizontal = along === 'x'
  const size = length * scale
  return (
    <svg aria-hidden className="absolute bg-background text-muted-foreground" style={horizontal ? { left: 0, top: 0, width: size, height: BAND } : { left: 0, top: 0, width: BAND, height: size }}>
      {span && (
        <rect
          className="fill-brand/15"
          {...(horizontal ? { x: span[0] * scale, y: 0, width: (span[1] - span[0]) * scale, height: BAND } : { x: 0, y: span[0] * scale, width: BAND, height: (span[1] - span[0]) * scale })}
        />
      )}
      {marks.map((v) => {
        const at = v * scale + 0.5
        const long = v % major === 0
        const len = long ? 8 : 4
        return horizontal ? (
          <line key={v} x1={at} x2={at} y1={BAND - len} y2={BAND} stroke="currentColor" strokeOpacity={long ? 0.6 : 0.3} />
        ) : (
          <line key={v} y1={at} y2={at} x1={BAND - len} x2={BAND} stroke="currentColor" strokeOpacity={long ? 0.6 : 0.3} />
        )
      })}
      {marks
        .filter((v) => v % major === 0 && v > 0)
        .map((v) =>
          horizontal ? (
            <text key={v} x={v * scale + 3} y={13} className="fill-current text-xs tabular-nums">
              {v}
            </text>
          ) : (
            <text key={v} x={13} y={v * scale + 3} transform={`rotate(-90 13 ${v * scale + 3})`} textAnchor="end" className="fill-current text-xs tabular-nums">
              {v}
            </text>
          ),
        )}
      {pointer !== null &&
        (horizontal ? (
          <line x1={pointer * scale} x2={pointer * scale} y1={0} y2={BAND} className="stroke-brand" />
        ) : (
          <line y1={pointer * scale} y2={pointer * scale} x1={0} x2={BAND} className="stroke-brand" />
        ))}
    </svg>
  )
}

export function Rulers({ on, width, height, scale, pointer }: { on: boolean; width: number; height: number; scale: number; pointer: Pointer | null }) {
  if (!on) return null
  const box = pointer?.box ?? null
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {pointer && (
        <>
          <div className="absolute inset-y-0 w-px bg-brand/40" style={{ left: pointer.x * scale }} />
          <div className="absolute inset-x-0 h-px bg-brand/40" style={{ top: pointer.y * scale }} />
        </>
      )}
      {box && (
        <div className="absolute border border-dashed border-brand" style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}>
          <span
            className={`absolute left-0 rounded-(--control-radius) ${box.y * scale < BAND + 24 ? 'top-full mt-1' : 'bottom-full mb-1'} bg-brand px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white tabular-nums`}
          >
            {pointer?.label ? `${pointer.label} ` : ''}
            {Math.round(box.width)} × {Math.round(box.height)}
          </span>
        </div>
      )}
      <div className="absolute inset-x-0 top-0 border-b" style={{ height: BAND }} />
      <div className="absolute inset-y-0 left-0 border-r" style={{ width: BAND }} />
      <Ruler length={width} scale={scale} along="x" pointer={pointer?.x ?? null} span={box ? [box.x, box.x + box.width] : null} />
      <Ruler length={height} scale={scale} along="y" pointer={pointer?.y ?? null} span={box ? [box.y, box.y + box.height] : null} />
      <div className="absolute top-0 left-0 bg-background" style={{ width: BAND, height: BAND }} />
      {pointer && (
        <span
          className="absolute rounded-(--control-radius) bg-foreground px-1.5 py-0.5 font-mono text-xs text-background tabular-nums"
          style={{ left: pointer.x * scale + 8, top: pointer.y * scale + 8 }}
        >
          {Math.round(pointer.x)}, {Math.round(pointer.y)}
        </span>
      )}
    </div>
  )
}
