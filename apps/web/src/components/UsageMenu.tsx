import { ArrowUpRightIcon } from 'lucide-react'
import { useUsage } from '@dorks/client/react'
import type { Usage, UsageWindow } from '@dorks/client'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { InputGroupButton } from '@dorks/ui/input-group'
import type { AgentProvider } from './ChatComposer'

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const hours = (h: number) => (h < 10 ? h.toFixed(1) : Math.round(h).toString())
const dollars = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })
const pct = (used: number) => `${Math.round(clamp(used) * 100)}%`
const clamp = (n: number) => Math.min(Math.max(n, 0), 1)
/** A reset within a day by its time, a later one by weekday and time. */
const resets = (at: number | undefined) => (at === undefined ? undefined : `Resets ${(at - Date.now() < 86_400_000 ? time : dayTime).format(at)}`)

/** The model plan behind each agent: Claude's subscription, Antigravity's Google AI plan. Codex and OpenCode report none to Dorks. */
// `usage`: the provider's own usage page on the web, where there is one (Google has none for the AI plan's Antigravity limits).
const PLANS: Partial<Record<AgentProvider, { key: 'claude' | 'google'; name: string; usage?: string }>> = {
  claude: { key: 'claude', name: 'Claude', usage: 'https://claude.ai/settings/usage' },
  antigravity: { key: 'google', name: 'Gemini' },
}
/** Boat's dashboard: the plan, machine time and wallet. */
const BOAT_USAGE = 'https://boat.dev/dashboard'

/** One limit as shown: a label, when it resets, and the share used. */
type Limit = { label: string; used: number; note?: string; title?: string }

/** The provider's model limits, then Boat's included machine time: the first sets the ring, the fullest of them really. */
function limitsOf(usage: Usage, provider: AgentProvider) {
  const plan = PLANS[provider]
  const model = plan ? usage[plan.key] : undefined
  const modelLimits: Limit[] = model ? [...(model.session ? [limitOf('Session · 5 hours', model.session)] : []), limitOf(provider === 'claude' ? 'Weekly · all models' : 'Weekly', model.weekly)] : []
  const cloud = usage.cloud
  const machine: Limit | undefined =
    cloud?.usedHours !== undefined && cloud.includedHours
      ? {
          label: 'Machine time',
          used: cloud.usedHours / cloud.includedHours,
          note: cloud.periodEnd ? `Renews ${date.format(cloud.periodEnd)}` : undefined,
          title: `${hours(cloud.usedHours)} of ${hours(cloud.includedHours)} hours used`,
        }
      : undefined
  return { plan, modelLimits, cloud, machine }
}

const limitOf = (label: string, w: UsageWindow): Limit => ({ label, used: w.used, note: resets(w.resetsAt) })

export function UsageMenu({ provider }: { provider: AgentProvider }) {
  const usage = useUsage()
  return usage ? <UsageMenuView usage={usage} provider={provider} /> : null
}

/**
 * Usage beside the composer's model menu: a ring filled to the fullest limit that matters for this chat (its agent's plan, else
 * Boat's machine time), and on click a menu with the agent's model limits (Claude's session and weekly windows, Antigravity's
 * Gemini ones; Codex and OpenCode have none here) and the Boat account (machine time, starts, running sandboxes, wallet). Nothing
 * when no account reports anything.
 */
export function UsageMenuView({ usage, provider }: { usage: Usage; provider: AgentProvider }) {
  const { plan, modelLimits, cloud, machine } = limitsOf(usage, provider)
  if (!modelLimits.length && !cloud) return null
  const ring = Math.max(...[...modelLimits, ...(machine ? [machine] : [])].map((l) => l.used), cloud?.blocked ? 1 : 0)
  const label = `Usage: ${pct(ring)} of the fullest limit used`
  return (
    <Popover>
      <PopoverTrigger
        render={
          <InputGroupButton
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            title={label}
            className="-ml-2 size-7 shrink-0 text-muted-foreground hover:text-foreground data-popup-open:bg-foreground/[0.07]"
          />
        }
      >
        <Ring used={ring} />
      </PopoverTrigger>
      {/* Styled as the app's dropdown menus (hairline, soft shadow), like the repository picker; `ring-0` drops the popover's own ring,
          which doubled the hairline. */}
      <PopoverContent align="end" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 text-[13px] ring-0`}>
        {modelLimits.length > 0 && plan && (
          <Section title={plan.name} href={plan.usage}>
            {modelLimits.map((l) => (
              <Bar key={l.label} limit={l} />
            ))}
          </Section>
        )}
        {cloud && (
          <Section title="Boat" href={BOAT_USAGE} divided={modelLimits.length > 0}>
            {cloud.blocked && (
              <p role="alert" className="text-destructive">
                {cloud.blocked}
              </p>
            )}
            {machine && <Bar limit={machine} />}
            {(cloud.startsHour || cloud.startsDay) && (
              <Row
                label="Starts"
                value={[cloud.startsHour && `${cloud.startsHour.used}/${cloud.startsHour.limit} this hour`, cloud.startsDay && `${cloud.startsDay.used}/${cloud.startsDay.limit} today`]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
            {cloud.sandboxes && <Row label="Running sandboxes" value={`${cloud.sandboxes.used} of ${cloud.sandboxes.limit}`} />}
            {cloud.walletDollars !== undefined && <Row label="Wallet" value={dollars.format(cloud.walletDollars)} />}
          </Section>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A titled group with a link to the provider's usage page on the web (opened in the browser); a full-width hairline above every group but the first. */
function Section({ title, href, divided, children }: { title: string; href?: string; divided?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} className={`flex flex-col gap-3 px-3.5 pt-3 pb-3.5 ${divided ? 'border-t border-border' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-muted-foreground">{title}</span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${title} usage`}
            title={`${title} usage`}
            className="-my-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        )}
      </div>
      {children}
    </section>
  )
}

/** A limit: label, then its reset and share used, over a brand-blue bar of the share used (red from 90%). */
function Bar({ limit }: { limit: Limit }) {
  const used = clamp(limit.used)
  return (
    <div title={limit.title} className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate">{limit.label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {limit.note && <span className="mr-2">{limit.note}</span>}
          {pct(used)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${limit.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used * 100)}
        className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <div className={`h-full rounded-full ${used >= 0.9 ? 'bg-destructive' : 'bg-brand'}`} style={{ width: `${used * 100}%` }} />
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">{value}</span>
    </div>
  )
}

/** A 16px progress ring: a faint track and a brand-blue arc of the share used, from 12 o'clock clockwise (red from 90%). */
function Ring({ used }: { used: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const u = clamp(used)
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
      <circle cx={8} cy={8} r={r} fill="none" strokeWidth={2} className="stroke-foreground/15" />
      {u > 0 && (
        <circle cx={8} cy={8} r={r} fill="none" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${Math.max(u * c, 0.01)} ${c}`} className={u >= 0.9 ? 'stroke-destructive' : 'stroke-brand'} />
      )}
    </svg>
  )
}
