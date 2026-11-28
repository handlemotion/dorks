import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ProdlikeAllowance, TwinBuild, TwinColumn, ProdlikeMeter, TwinNeonProject, TwinStrategy, TwinView } from '@dorks/client'
import { ApiError } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Progress } from '@dorks/ui/progress'
import { Switch } from '@dorks/ui/switch'
import { isDesktop, openExternal } from '../../lib/desktop'
import { usePending } from '../../lib/pending'
import { SettingsGroup, SettingsGroupBody, SettingsGroupFooter, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus, SettingsValueRow } from './kit'

// Settings › Twin Engine (dorks-cloud src/prodlike): sessions test against a scrubbed copy of production, each on a database branch of
// its own. Two ways in, each a click or two: Connect Neon (the team's own Neon account; pick production), or hosted (Dorks runs a Neon
// project for the team; the setup agent finds the database, the owner gives a read-only URL once in a secure form). Dorks Teams, with a
// monthly allowance (spans and errors, and hosted data): past a limit that part pauses until the 1st, nothing is billed extra.

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never')
const STRATEGY_LABEL: Record<TwinStrategy, string> = {
  keep: 'Keep',
  email: 'Fake email',
  name: 'Fake name',
  phone: 'Fake phone',
  address: 'Fake address',
  ip: 'Test IP',
  date: 'Year only',
  hash: 'Hash',
  redact: 'Redact',
  null: 'Empty (NULL)',
}

export function TwinEnginePage() {
  const { api } = useDorksClient()
  const [view, setView] = useState<TwinView | null>(null)
  const [missing, setMissing] = useState(false)
  const { run, pending, error } = usePending()
  const load = useCallback(async () => {
    try {
      setView(await api.twin())
    } catch (e) {
      // A server that is not a Worker-run team (this Mac, Dorks Local) has no Twin Engine.
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setMissing(true)
      else throw e
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  const busy = view?.builds[0] && (view.builds[0].state === 'queued' || view.builds[0].state === 'running')
  const awaiting = view?.mode === 'hosted' && !view.source
  useEffect(() => {
    if (!busy && !awaiting) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [busy, awaiting, load])

  if (missing || (view && !view.allowed)) return <UpgradePrompt />
  if (!view) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  const act = (fn: () => Promise<unknown>) => void run(async () => (await fn(), await load()))
  return <TwinBody view={view} act={act} pending={pending} error={error} awaiting={!!awaiting} />
}

function TwinBody({ view, act, pending, error, awaiting }: { view: TwinView; error: string; awaiting: boolean } & Act) {
  return (
    <SettingsSections>
      <SettingsSection
        title="Twin Engine"
        description="Sessions test against a scrubbed copy of production: each gets a database branch of its own, with personal data masked. The Validation Engine still checks every change on the session's own servers."
      >
        {!view.source && view.mode !== 'hosted' && !view.neon.connected && <Choose view={view} act={act} pending={pending} />}
        {view.neon.connected && !view.source && <PickProduction act={act} pending={pending} />}
        {awaiting && <HostedUrl view={view} act={act} pending={pending} />}
        {view.source && <Status view={view} act={act} pending={pending} />}
        <SettingsStatus error={error} />
      </SettingsSection>
      {view.allowance && <Allowance allowance={view.allowance} />}
      {view.source && view.rules && <Rules view={view} act={act} pending={pending} />}
      {(view.neon.connected || view.mode === 'hosted') && <Disconnect hosted={view.mode === 'hosted'} act={act} pending={pending} />}
    </SettingsSections>
  )
}

function Disconnect({ hosted, act, pending }: { hosted: boolean } & Act) {
  const { api } = useDorksClient()
  return (
    <SettingsSection title="Disconnect">
      <SettingsGroup label="disconnect">
        <SettingsRow
          label={hosted ? 'Delete the hosted copy' : 'Disconnect Neon'}
          description={
            hosted ? 'Deletes the team’s Neon project at Dorks and the refresh. Sessions test locally again.' : 'Deletes the scrubbed copies Dorks made and the refresh. Your production is untouched.'
          }
          control={
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => act(() => api.twinDisconnect())}>
              {hosted ? 'Delete' : 'Disconnect'}
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  )
}

type Act = { act: (fn: () => Promise<unknown>) => void; pending: boolean }

/** The 1st of next month, UTC (when the allowance resets): `Dec 1`. */
const resetDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

/** This month's allowance: each part used of its limit, and what is paused past one. */
function Allowance({ allowance: a }: { allowance: ProdlikeAllowance }) {
  const paused = [a.paused.traces, a.paused.data].filter((p): p is string => !!p)
  return (
    <SettingsSection title="This month" description={`Included with Dorks Teams. Resets ${resetDay(a.resetsAt)}. Usage is read every hour.`}>
      <SettingsGroup label="allowance">
        {paused.map((p) => (
          <SettingsGroupBody key={p} role="alert" className="text-amber-700 dark:text-amber-400">
            {p}
          </SettingsGroupBody>
        ))}
        <Meter label="Spans" meter={a.spans} />
        <Meter label="Error events" meter={a.errors} />
        {a.hosted && <Meter label="Hosted data" meter={a.hosted.storageGb} unit="GB" />}
        {a.hosted && <Meter label="Compute hours" meter={a.hosted.computeCuHours} />}
      </SettingsGroup>
    </SettingsSection>
  )
}

/** One part of the allowance: used of limit, and a thin bar (red once it is used up). */
function Meter({ label, meter, unit }: { label: string; meter: ProdlikeMeter; unit?: string }) {
  const share = meter.limit > 0 ? Math.min(1, Math.max(0, meter.used / meter.limit)) : 0
  const value = `${count.format(meter.used)} of ${count.format(meter.limit)}${unit ? ` ${unit}` : ''}`
  return (
    <SettingsRow
      label={label}
      className="pe-4"
      control={
        <div className="flex w-full flex-col gap-1.5 @md:w-48 @md:items-end">
          <span className="text-sm tabular-nums">{value}</span>
          <Progress
            value={Math.round(share * 100)}
            aria-label={`${label} used`}
            className={`w-full [&_[data-slot=progress-track]]:h-1 ${share >= 1 ? '[&_[data-slot=progress-indicator]]:bg-destructive' : '[&_[data-slot=progress-indicator]]:bg-brand'}`}
          />
        </div>
      }
    />
  )
}

function UpgradePrompt() {
  return (
    <SettingsSections>
      <SettingsSection title="Twin Engine" description="Sessions test against a scrubbed copy of production, each on a database branch of its own.">
        <SettingsGroup label="upgrade">
          <SettingsRow
            label="Comes with Dorks Teams"
            description="Upgrade the organization to set it up. Until then, sessions test with the Validation Engine on their own servers."
            control={
              <Button size="sm" render={<Link to="/settings/$page" params={{ page: 'organization' }} />}>
                Upgrade
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsSections>
  )
}

function Choose({ view, act, pending }: { view: TwinView } & Act) {
  const { api } = useDorksClient()
  const [apiKey, setApiKey] = useState('')
  const [region, setRegion] = useState('')
  const [regions, setRegions] = useState<{ id: string; name: string; default: boolean }[]>([])
  useEffect(() => {
    if (!view.hosted.available) return
    void api.twinRegions().then(
      (r) => {
        setRegions(r.regions)
        setRegion((cur) => cur || (r.regions.find((x) => x.default) ?? r.regions[0])?.id || '')
      },
      () => {},
    )
  }, [api, view.hosted.available])
  const connect = () =>
    act(async () => {
      const returnTo = isDesktop() ? 'dorks://prodlike' : window.location.href
      const { url } = await api.twinConnect(returnTo)
      if (isDesktop()) openExternal(url)
      else window.location.href = url
    })
  return (
    <>
      <SettingsGroup label="connect neon">
        <SettingsRow
          label="Your Neon"
          description="Production is on Neon: sign in, then click your production project. Masking, the first copy and the nightly refresh are set up for you."
          control={
            view.neon.oauthAvailable ? (
              <Button type="button" size="sm" disabled={pending} onClick={connect}>
                Connect Neon
              </Button>
            ) : undefined
          }
        />
        {!view.neon.oauthAvailable && (
          <SettingsInputRow
            id="neon-api-key"
            label="Neon API key"
            description="Neon sign-in is not available here yet. A key works the same; it never leaves Dorks."
            type="password"
            autoComplete="off"
            placeholder="napi_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            trailing={
              <Button type="button" size="sm" disabled={pending || !apiKey.trim()} onClick={() => act(() => api.twinApiKey(apiKey.trim()))}>
                Connect
              </Button>
            }
          />
        )}
      </SettingsGroup>
      {view.hosted.available && (
        <SettingsGroup label="hosted by dorks">
          <SettingsRow
            label="Hosted by Dorks"
            description="No Neon account needed. Your setup agent finds the app’s database; you give a read-only URL once, in a secure form. Dorks keeps the copy in a Neon project of your team’s own."
          />
          {regions.length > 0 && <SettingsSelectRow label="Region" value={region} options={regions.map((r) => ({ value: r.id, label: r.name }))} onValueChange={setRegion} />}
          <SettingsGroupFooter
            action={
              <Button type="button" size="sm" variant="outline" disabled={pending || !region} onClick={() => act(() => api.twinHosted(region))}>
                Use hosted
              </Button>
            }
          />
        </SettingsGroup>
      )}
    </>
  )
}

function PickProduction({ act, pending }: Act) {
  const { api } = useDorksClient()
  const [projects, setProjects] = useState<TwinNeonProject[] | null>(null)
  const [url, setUrl] = useState('')
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => {
    void api.twinProjects().then(
      (r) => setProjects(r.projects.filter((p) => !p.copy)),
      () => setProjects([]),
    )
  }, [api])
  return (
    <SettingsGroup label="production">
      <SettingsRow label="Which project is production?" description="Dorks branches it, masks personal data on the branch, checks it, and only then lets sessions branch from it." />
      {projects === null && <SettingsRow label="Loading your projects…" />}
      {projects?.map((p) => (
        <SettingsRow
          key={p.id}
          label={p.name}
          description={[p.orgName, p.region].filter(Boolean).join(' · ')}
          control={
            <Button type="button" size="sm" disabled={pending} onClick={() => act(() => api.twinSource({ projectId: p.id, timezone: tz() }))}>
              Use as production
            </Button>
          }
        />
      ))}
      {!advanced ? (
        <SettingsGroupFooter
          action={
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdvanced(true)}>
              Production is not on Neon
            </Button>
          }
        />
      ) : (
        <SettingsInputRow
          id="prod-url"
          label="Read-only Postgres URL"
          description="Copied into a project in your Neon, masked as it is copied. Stored sealed; never shown again or given to a session."
          type="password"
          autoComplete="off"
          placeholder="postgresql://readonly:…@host/db"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          trailing={
            <Button type="button" size="sm" disabled={pending || !url.trim()} onClick={() => act(() => api.twinSource({ url: url.trim(), timezone: tz() }))}>
              Copy
            </Button>
          }
        />
      )}
    </SettingsGroup>
  )
}

function HostedUrl({ view, act, pending }: { view: TwinView } & Act) {
  const { api } = useDorksClient()
  const [url, setUrl] = useState('')
  return (
    <SettingsGroup label="production url">
      <SettingsValueRow label="Hosted by Dorks" value={view.hosted.region ?? 'Default region'} />
      {view.twin && <SettingsValueRow label="Found by the setup agent" value={[view.twin.envVar, view.twin.orm].filter(Boolean).join(' · ')} mono />}
      {view.hosted.awaitingUrl && (
        <SettingsRow
          label="The setup session is asking for production’s read URL"
          description="Answer its secure form there, or here."
          control={
            <Button size="sm" variant="outline" render={<Link to="/dorks" search={{ dork: view.hosted.awaitingUrl.sessionId }} />}>
              Open the session
            </Button>
          }
        />
      )}
      <SettingsInputRow
        id="hosted-url"
        label="Production read URL"
        description="A read-only role. Stored sealed; never shown again or given to a session or an agent."
        type="password"
        autoComplete="off"
        placeholder="postgresql://readonly:…@host/db"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        trailing={
          <Button type="button" size="sm" disabled={pending || !url.trim()} onClick={() => act(() => api.twinHostedUrl(url.trim(), tz()))}>
            Copy
          </Button>
        }
      />
    </SettingsGroup>
  )
}

const BUILD_STATE: Record<TwinBuild['state'], string> = { ready: 'Ready', failed: 'Failed: sessions keep the copy they had', queued: 'Queued', running: 'Building…' }
const BUILD_TONE = { ready: 'success', failed: 'danger', queued: 'muted', running: 'muted' } as const

function sourceLabel(view: TwinView) {
  if (view.source?.kind === 'neon') return 'Your Neon project'
  if (view.mode === 'hosted') return view.hosted.region ? `Hosted by Dorks · ${view.hosted.region}` : 'Hosted by Dorks'
  return 'A Postgres URL, copied into your Neon'
}

function Status({ view, act, pending }: { view: TwinView } & Act) {
  const last = view.builds[0]
  return (
    <SettingsGroup label="status">
      <SettingsValueRow label="Production" value={sourceLabel(view)} />
      <SettingsValueRow
        label="Scrubbed copy"
        description={view.parent ? `Built ${when(view.parent.builtAt)}` : undefined}
        value={last ? BUILD_STATE[last.state] : 'Not built yet'}
        tone={last ? BUILD_TONE[last.state] : 'muted'}
        valueTestId="twin-state"
      />
      {last && <LastBuild build={last} />}
      <Refresh view={view} act={act} pending={pending} />
    </SettingsGroup>
  )
}

function LastBuild({ build }: { build: TwinBuild }) {
  if (build.state === 'failed' && build.error) return <SettingsRow label="Why" description={build.error} />
  if (build.state !== 'ready' || !build.stats) return null
  return <SettingsValueRow label="Last build" value={`${build.stats.tables} tables · ${build.stats.masked} masked columns · ${Math.round(build.stats.ms / 100) / 10} s`} />
}

function Refresh({ view, act, pending }: { view: TwinView } & Act) {
  const { api } = useDorksClient()
  const last = view.builds[0]
  const busy = last?.state === 'queued' || last?.state === 'running'
  return (
    <>
      {view.refresh && (
        <SettingsRow
          label="Refresh nightly"
          description={view.refresh.enabled ? `${view.refresh.schedule}. Next: ${when(view.refresh.nextRunAt)}` : 'Off: the copy stays as it is'}
          control={<Switch aria-label="refresh nightly" checked={view.refresh.enabled} disabled={pending} onCheckedChange={(on) => act(() => api.twinRefresh(on, tz()))} />}
        />
      )}
      {view.hosted.usage && !view.allowance && <SettingsValueRow label="This month" value={`${view.hosted.usage.computeHours} compute h · $${(view.hosted.usage.cents / 100).toFixed(2)}`} />}
      <SettingsGroupFooter
        action={
          <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={() => act(() => api.twinRebuild())}>
            Rebuild now
          </Button>
        }
      />
    </>
  )
}

function Rules({ view, act, pending }: { view: TwinView } & Act) {
  const { api } = useDorksClient()
  const rules = view.rules!
  const [all, setAll] = useState(false)
  const [edits, setEdits] = useState<Record<string, TwinStrategy>>({})
  const key = (c: TwinColumn) => `${c.schema}.${c.table}.${c.column}`
  const shown = useMemo(() => rules.columns.filter((c) => all || c.flagged || c.strategy !== 'keep'), [rules.columns, all])
  const changed = Object.keys(edits).length > 0
  return (
    <SettingsSection
      title="Masking"
      description={`${rules.masked} of ${rules.columns.length} columns masked${rules.reviewedAt ? '' : ', by default'}. A column added later is masked by default when it looks personal, and every copy is checked for email addresses before sessions can use it.`}
    >
      <SettingsGroup label="masking rules">
        {shown.map((c) => (
          <SettingsSelectRow
            key={key(c)}
            label={`${c.table}.${c.column}`}
            description={c.reason || c.type}
            value={edits[key(c)] ?? c.strategy}
            options={(Object.keys(STRATEGY_LABEL) as TwinStrategy[]).map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
            onValueChange={(s) => setEdits((e) => ({ ...e, [key(c)]: s }))}
          />
        ))}
        <SettingsGroupFooter
          action={
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
                {all ? 'Only personal columns' : 'All columns'}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending || !changed}
                onClick={() =>
                  act(async () => {
                    await api.twinRules(rules.columns.map((c) => ({ schema: c.schema, table: c.table, column: c.column, strategy: edits[key(c)] ?? c.strategy })))
                    setEdits({})
                  })
                }
              >
                Save and rebuild
              </Button>
            </>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  )
}
