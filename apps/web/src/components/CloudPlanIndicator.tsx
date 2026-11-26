import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, type CloudEntitlements, type DorksClient, type QueryState, type Store } from '@dorks/client'
import { useStoreValue, useUsage } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { openExternal } from '../lib/desktop'
import { useCloudPlace } from './CloudPlace'
import { SIDEBAR_ROW } from './sidebarChrome'
import { Bar, Ring, Row, Section } from './UsageMenu'

/** How often a visible page reads the plan again: hours tick while sandboxes run. */
const POLL_MS = 60_000
/** From this share of the hours used, the indicator warns. */
const WARN_AT = 0.8

const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dollars = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })
/** Minutes as hours: one decimal under 10 hours, whole hours above. */
const hours = (min: number) => {
  const h = Math.max(min, 0) / 60
  return h < 10 ? (Math.round(h * 10) / 10).toString() : Math.round(h).toString()
}
const pct = (share: number) => `${Math.round(Math.min(Math.max(share, 0), 1) * 100)}%`

/** What the indicator shows for an org's plan; null for anything but Dorks Cloud (paid, on its trial, or a trial used up with no plan). */
export type CloudPlanView = {
  trial: boolean
  /** Share of the hours used, 0..1. */
  used: number
  usedMinutes: number
  totalMinutes: number
  leftMinutes: number
  state: 'ok' | 'warn' | 'used_up'
  periodEnd: number | null
  /** Paid Cloud only. */
  overage?: CloudEntitlements['overage']
  maxConcurrentSandboxes: number
}

export function cloudPlanView(ent: CloudEntitlements): CloudPlanView | null {
  const trial = ent.trial?.kind === 'cloud_hours' ? ent.trial : null
  // A Cloud trial used up falls back to Local or Teams: only an org left with no plan (Local) is still told to subscribe here; Teams
  // keeps working on its own Boat key.
  if (ent.plan !== 'cloud' && !(trial && trial.minutesLeft <= 0 && trial.fallbackPlan === 'local')) return null
  if (trial) {
    const used = trial.minutes ? trial.usedMinutes / trial.minutes : 1
    return {
      trial: true,
      used,
      usedMinutes: trial.usedMinutes,
      totalMinutes: trial.minutes,
      leftMinutes: trial.minutesLeft,
      state: trial.minutesLeft <= 0 ? 'used_up' : used >= WARN_AT ? 'warn' : 'ok',
      periodEnd: null,
      maxConcurrentSandboxes: ent.maxConcurrentSandboxes,
    }
  }
  const used = ent.includedMinutes ? ent.usedMinutes / ent.includedMinutes : 0
  const leftMinutes = Math.max(0, ent.includedMinutes - ent.usedMinutes)
  // Past the allowance, overage (when on) keeps sandboxes running until its cap.
  const capped = !ent.overage.enabled || ent.overage.spentCents >= ent.overage.capCents
  return {
    trial: false,
    used,
    usedMinutes: ent.usedMinutes,
    totalMinutes: ent.includedMinutes,
    leftMinutes,
    state: leftMinutes <= 0 ? (capped ? 'used_up' : 'warn') : used >= WARN_AT ? 'warn' : 'ok',
    periodEnd: ent.periodEnd,
    overage: ent.overage,
    maxConcurrentSandboxes: ent.maxConcurrentSandboxes,
  }
}

const IDLE: QueryState<CloudEntitlements> = { status: 'ready', data: undefined, error: undefined }
const idle: Store<QueryState<CloudEntitlements>> = { getSnapshot: () => IDLE, subscribe: () => () => {} }

/** The org in use and its entitlements, read through the home server and again every minute while the page is visible. */
function useOrgEntitlements() {
  const place = useCloudPlace()
  const org = place?.cloud?.user ? place.org : null
  const home = place?.home
  const ent = useStoreValue(org && home ? home.cloudEntitlements(org.id) : idle).data
  useEffect(() => {
    if (!org || !home) return
    const refresh = () => document.visibilityState === 'visible' && home.refreshCloudEntitlements()
    const timer = setInterval(refresh, POLL_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [org, home])
  return { org, home, ent }
}

/** Opens one of the org's Stripe pages (Checkout to subscribe, the portal to manage the plan) in the browser. */
async function openBilling(home: DorksClient, orgId: string, page: 'checkout' | 'portal') {
  try {
    const { url } = page === 'checkout' ? await home.api.cloudCheckout(orgId, 'cloud') : await home.api.cloudBillingPortal(orgId)
    openExternal(url)
  } catch (e) {
    // Dorks Cloud's billing codes are not the app's (`unavailable`), so its answer reads as a bare status: say it plainly.
    const status = e instanceof ApiError ? e.status : 0
    toast.error(
      status === 403
        ? "Only the team's owner can change its billing."
        : status === 503
          ? 'Billing is not available right now. Try again later.'
          : e instanceof Error
            ? e.message
            : 'Could not open billing.',
    )
  }
}

/**
 * Dorks Cloud's sandbox hours above the account menu, only for an org on Dorks Cloud (paid or on its trial): a ring of the hours
 * used and what is left; a warning from 80% used (or the trial nearly over), and Subscribe once the hours are used up. A click opens
 * the plan's details with Manage plan (Stripe's portal in the browser). Local and Teams orgs see nothing here: their usage is in the
 * composer's usage menu.
 */
export function CloudPlanIndicator() {
  const plan = useCloudPlan()
  const running = useUsage()?.cloud?.sandboxes?.used
  if (!plan) return null
  return <CloudPlanIndicatorView {...plan} running={running} />
}

/**
 * The org in use on Dorks Cloud (`cloudPlanView`; null otherwise), whether the account may change its billing (owners), and the
 * actions that open Stripe in the browser.
 */
export function useCloudPlan() {
  const { org, home, ent } = useOrgEntitlements()
  const view = ent && cloudPlanView(ent)
  if (!org || !home || !view) return null
  return {
    view,
    canManage: !!org.role?.split(',').some((r) => r.trim() === 'owner'),
    onOpen: () => home.refreshCloudEntitlements(),
    onSubscribe: () => void openBilling(home, org.id, 'checkout'),
    onManage: () => void openBilling(home, org.id, 'portal'),
  }
}

function headline(v: CloudPlanView) {
  if (v.state === 'used_up') return { label: v.trial ? 'Trial hours used up' : 'Sandbox hours used up', value: '' }
  if (v.trial) return { label: v.state === 'warn' ? 'Cloud trial ending' : 'Cloud trial', value: `${hours(v.leftMinutes)} h left` }
  if (v.leftMinutes <= 0) return { label: 'On overage', value: '' }
  return { label: v.state === 'warn' ? `${pct(v.used)} of hours used` : 'Sandbox hours', value: `${hours(v.usedMinutes)} / ${hours(v.totalMinutes)} h` }
}

/** The indicator from props alone (demos, screenshots). */
export function CloudPlanIndicatorView({
  view: v,
  running,
  canManage,
  onOpen,
  onSubscribe,
  onManage,
}: {
  view: CloudPlanView
  /** Sandboxes running now (the org's usage), when known. */
  running?: number
  /** Owners change billing; others are told to ask them. */
  canManage: boolean
  onOpen?: () => void
  onSubscribe: () => void
  onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const { label, value } = headline(v)
  const alert = v.state !== 'ok'
  const subscribe = v.trial && canManage
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <PopoverTrigger
          aria-label={`Dorks Cloud usage: ${label}${value ? `, ${value}` : ''}`}
          className={`${SIDEBAR_ROW} flex-1 data-popup-open:bg-foreground/[0.05] ${alert ? 'text-foreground' : ''}`}
        >
          <Ring used={v.state === 'used_up' ? 1 : v.used} warn={alert} />
          <span className={`min-w-0 flex-1 truncate ${v.state === 'used_up' ? 'text-destructive' : ''}`}>{label}</span>
          {value && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{value}</span>}
        </PopoverTrigger>
        {v.state === 'used_up' && subscribe && (
          <Button size="sm" className="h-[26px] shrink-0 px-2.5" onClick={onSubscribe}>
            Subscribe
          </Button>
        )}
      </div>
      <PopoverContent side="top" align="start" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 text-[13px] ring-0`}>
        <CloudPlanDetails view={v} running={running} canManage={canManage} onSubscribe={onSubscribe} onManage={onManage} />
      </PopoverContent>
    </Popover>
  )
}

function warning(v: CloudPlanView) {
  if (v.state === 'used_up')
    return v.trial
      ? `Your ${hours(v.totalMinutes)} trial hours are used up. Subscribe to Dorks Cloud to keep sessions running.`
      : v.overage?.enabled
        ? "This month's overage cap is used up. Raise the cap to keep sessions running."
        : "This month's sandbox hours are used up. Turn on overage to keep sessions running."
  if (v.state !== 'warn') return undefined
  if (v.trial) return `${hours(v.leftMinutes)} of your ${hours(v.totalMinutes)} trial hours left. Subscribe to keep going.`
  if (v.leftMinutes <= 0) return `Included hours used up; sessions run on overage until its ${dollars.format((v.overage?.capCents ?? 0) / 100)} cap.`
  return `${pct(v.used)} of this month's hours used.`
}

/** The popover: the plan's hours, overage and sandboxes at once, a warning when it is running out, and the billing actions. */
export function CloudPlanDetails({ view: v, running, canManage, onSubscribe, onManage }: { view: CloudPlanView; running?: number; canManage: boolean; onSubscribe: () => void; onManage: () => void }) {
  const text = warning(v)
  return (
    <Section title={v.trial ? 'Dorks Cloud trial' : 'Dorks Cloud'}>
      {text && (
        <p role="alert" className={v.state === 'used_up' ? 'text-destructive' : 'text-foreground'}>
          {text}
        </p>
      )}
      <Bar
        limit={{
          label: v.trial ? 'Trial hours' : 'Sandbox hours',
          used: v.state === 'used_up' ? 1 : v.used,
          warn: v.state !== 'ok',
          note: v.trial ? `${hours(v.leftMinutes)} h left` : v.periodEnd ? `Renews ${date.format(v.periodEnd)}` : undefined,
          title: `${hours(v.usedMinutes)} of ${hours(v.totalMinutes)} hours used`,
        }}
      />
      <Row label="Hours used" value={`${hours(v.usedMinutes)} of ${hours(v.totalMinutes)}`} />
      {v.overage && <Row label="Overage" value={v.overage.enabled ? `${dollars.format(v.overage.spentCents / 100)} of ${dollars.format(v.overage.capCents / 100)} cap` : 'Off'} />}
      {v.maxConcurrentSandboxes > 0 && <Row label="Sandboxes at once" value={running === undefined ? `Up to ${v.maxConcurrentSandboxes}` : `${running} of ${v.maxConcurrentSandboxes} running`} />}
      {canManage ? (
        <div className="flex gap-2 pt-1">
          {v.trial && (
            <Button size="sm" onClick={onSubscribe}>
              Subscribe
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onManage}>
            Manage plan
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">Only the team's owner can change the plan.</p>
      )}
    </Section>
  )
}
