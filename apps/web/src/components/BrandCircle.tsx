/**
 * The brand circle: one thin ring, centered on the page and hanging from its top edge, wider than the window so only its upper
 * arc shows. Proportions are the Figma reference's (a 1883px ring on a 1512px-wide page), so it scales with the window width and
 * keeps the same composition. Its parent must be `relative isolate` (the ring sits at z -10) and `overflow-clip`: with `overflow-hidden` the page can still be scrolled sideways by focus (a closing dialog handing focus back), and the whole step slides off center.
 */
export function BrandCircle({ className = 'w-[124.54vw]' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute top-0 left-1/2 -z-10 aspect-square -translate-x-1/2 rounded-full border-2 border-brand-line ${className}`}
    />
  )
}
