import { useUsage } from '@dorks/client/react'
import type { Usage } from '@dorks/client'

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const hours = (h: number) => (h < 10 ? h.toFixed(1) : Math.round(h).toString())

export function UsageBar() {
  const usage = useUsage()
  return usage ? <UsageBarView usage={usage} /> : null
}

/** The bar's fill by what is left: green, orange under 20%, red under 10%. */
const tone = (left: number) => (left < 0.1 ? 'bg-destructive' : left < 0.2 ? 'bg-orange-500' : 'bg-emerald-500')

/**
 * The sidebar's usage, above Settings: a raised block with one meter per limit, each as the share left (Claude's 5-hour session and
 * weekly limit, Antigravity's Gemini 5-hour and weekly limits, Boat's monthly included machine time), and a strip under it with the next reset. Shows nothing when neither
 * account is set up. Codex has no meter: Dorks never holds its sign-in.
 *
 * Insets are 11px to the letters on every side, measured from the outer edge (balance-out, Geist 12/16: 3.5px above the capitals,
 * 4px under the baseline), so the card pads 6.5px on top and 10px elsewhere inside its 1px border, and the strip 7.5px / 7px / 11px.
 * In a meter a label's baseline sits 10px over its bar; a bar sits 15.5px over the next label's capitals.
 */
export function UsageBarView({ usage }: { usage: Usage }) {
  const { claude, google, cloud } = usage
  if (!claude && !google && !cloud) return null
  const session = claude?.session?.resetsAt ?? google?.session?.resetsAt
  const footer = session ? `Session resets ${time.format(session)}` : cloud?.periodEnd ? `Cloud renews ${day.format(cloud.periodEnd)}` : undefined
  return (
    <section aria-label="Usage" className="rounded-[6px] bg-foreground/[0.04]">
      <div className="flex flex-col gap-3 rounded-[6px] border border-border bg-surface px-[10px] pt-[6.5px] pb-[10px]">
        {/* No 5-hour window reported (plans without session limits, such as Claude's Ultra): no session meter. */}
        {claude && <Limits name="Claude" limits={claude} />}
        {google && <Limits name="Gemini" limits={google} />}
        {cloud && (
          <Meter
            label="Cloud monthly"
            used={cloud.usedHours / cloud.includedHours}
            title={`${hours(cloud.usedHours)} of ${hours(cloud.includedHours)} hours used${cloud.periodEnd ? `, renews ${day.format(cloud.periodEnd)}` : ''}`}
          />
        )}
      </div>
      {footer && <div className="truncate px-[11px] pt-[7.5px] pb-[7px] text-xs leading-4 text-muted-foreground tabular-nums">{footer}</div>}
    </section>
  )
}

/** A plan's 5-hour session (when it reports one) and weekly limit. */
function Limits({ name, limits }: { name: string; limits: NonNullable<Usage['claude']> }) {
  const { session, weekly } = limits
  return (
    <>
      {session && <Meter label={`${name} session`} used={session.used} title={session.resetsAt ? `Resets ${time.format(session.resetsAt)}` : undefined} />}
      <Meter label={`${name} weekly`} used={weekly.used} title={weekly.resetsAt ? `Resets ${day.format(weekly.resetsAt)}` : undefined} />
    </>
  )
}

function Meter({ label, used, title }: { label: string; used: number; title?: string }) {
  const left = 1 - Math.min(Math.max(used, 0), 1)
  return (
    <div title={title} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs leading-4">
        <span className="truncate text-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{Math.round(left * 100)}% left</span>
      </div>
      <div role="meter" aria-label={`${label} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left * 100)} className="h-1 overflow-hidden rounded-[2px] bg-foreground/[0.07]">
        <div className={`h-full rounded-[2px] ${tone(left)}`} style={{ width: `${left * 100}%` }} />
      </div>
    </div>
  )
}
