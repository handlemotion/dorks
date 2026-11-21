/** A thin progress line (4px): the setup checklist's count, and the Boat snapshot build in Settings. */
export function StepProgress({ step, of, label, tone = 'muted' }: { step: number; of: number; label: string; tone?: 'muted' | 'brand' }) {
  const percent = Math.round((Math.min(step, of) / Math.max(of, 1)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 overflow-hidden rounded-[2px] bg-foreground/[0.07]">
      <div className={`h-full rounded-[2px] transition-[width] duration-300 ease-out ${tone === 'brand' ? 'bg-brand' : 'bg-muted-foreground/60'}`} style={{ width: `${percent}%` }} />
    </div>
  )
}
