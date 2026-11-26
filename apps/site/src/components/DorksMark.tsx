import { useId } from "react";

const SHAPE_PATH =
  "M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40";

/**
 * The Dorks mark, in currentColor. `flapsOnHover`: while a `.dorks-mark-hover` ancestor is hovered, it plays the app's working
 * animation (apps/web DorkIcon: four flaps cycling upward), unless the visitor prefers reduced motion (global.css).
 */
export function DorksMark({ size = 24, className, flapsOnHover }: { size?: number; className?: string; flapsOnHover?: boolean }) {
  const maskId = `dorks-mark-${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none" overflow="visible" aria-hidden="true" className={className}>
      <path d={SHAPE_PATH} fill="currentColor" className={flapsOnHover ? "dorks-mark-still" : undefined} />
      {flapsOnHover ? (
        <g className="dorks-mark-flaps">
          <defs>
            <mask id={maskId} width="200" height="220" x="0" y="-10" maskUnits="userSpaceOnUse" style={{ maskType: "alpha" }}>
              {[1, 2, 3, 4].map((n) => (
                <ellipse key={n} cx="100" cy="100" rx="80" ry="40" fill="#fff" className={`dork-flap dork-flap-${n}`} />
              ))}
            </mask>
          </defs>
          <rect x="0" y="-10" width="200" height="220" fill="currentColor" mask={`url(#${maskId})`} />
        </g>
      ) : null}
    </svg>
  );
}
