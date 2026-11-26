import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, EllipsisIcon, ExternalLinkIcon, HandIcon, PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import { modelLabel } from '@dorks/shared'
import type { AutomationInput, AutomationRunView, AutomationTrigger, AutomationView, BuildView } from '@dorks/client'
import { useAutomation, useAutomationRuns, useAutomations, useBuilds, useDorksClient, useGithubRepos, useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { Switch } from '@dorks/ui/switch'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { PageRail, RailPage } from '../../../components/PageRail'
import { Tip } from '../../../components/Tip'
import { DAYS, EVENTS, EVERY, GithubMark, SENTRY_EVENTS, SentryMark, TriggerList, TriggerMark } from '../../../components/automations/TriggerEditor'
import { localTimeZone, TEMPLATES, type AutomationTemplate } from '../../../components/automations/templates'
import { useAppWorkspace } from '../../../components/appWorkspace'
import { isTeamOrg, useCloudPlace } from '../../../components/CloudPlace'
import { SettingsFacts, SettingsGroup, SettingsGroupBody, SettingsInputRow, SettingsSection, SettingsSections, SettingsStatus, StatusDot, TONE_TEXT, type Tone } from '../../../components/settings/kit'
import { usePending } from '../../../lib/pending'
import { ago, upcoming } from '../../../lib/time'

// Automations (docs/automations.md): instructions an agent runs on a schedule, or when something happens in a repository; each run
// starts a session. Three pages on one route, laid out with the settings kit like Builds: the list with templates (`/automations`),
// a new automation (`?automation=new`, from a `&template=`), and an automation's settings with its run history (`?automation=<id>`).

type Search = { automation?: string; template?: string }

export const Route = createFileRoute('/_conn/_app/automations')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.automation === 'string' ? { automation: s.automation } : {}),
    ...(typeof s.template === 'string' ? { template: s.template } : {}),
  }),
  component: Automations,
})

function Automations() {
  const { automation, template } = Route.useSearch()
  // A new automation is the workspace's: switching workspaces starts the form over in the other one. Templates are code, so Chat has none.
  const [workspace] = useAppWorkspace()
  // Only a team org runs automations: a personal one has no always-on server, and this Mac sleeps or goes offline.
  const place = useCloudPlace()
  // Existing ones stay reachable so they can be paused or deleted (the server still runs what is enabled), but no new ones.
  const existing = useAutomations()
  const blocked = !place?.resolving && !isTeamOrg(place?.org) && existing !== undefined && (existing.length === 0 || automation === 'new')
  const navigate = useNavigate()
  useEffect(() => {
    if (blocked) void navigate({ to: '/dorks', replace: true })
  }, [blocked, navigate])
  if (place?.resolving || blocked || (!isTeamOrg(place?.org) && existing === undefined)) return null
  if (automation === 'new') return <NewAutomation key={`${template ?? ''}:${workspace}`} template={workspace === 'chat' ? undefined : TEMPLATES.find((t) => t.id === template)} />
  if (automation) return <AutomationPage key={automation} id={automation} />
  return <AutomationList />
}

/** The page body: the settings column. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 sm:px-6">
        <SettingsSections>{children}</SettingsSections>
      </div>
    </div>
  )
}

const ROW = 'flex min-h-13 w-full min-w-0 items-center gap-3 py-2.5 ps-4 pe-3 text-start text-sm'
const LINK_ROW = `${ROW} hover:bg-foreground/[0.025]`

function RowText({ title, description, tone }: { title: ReactNode; description?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate leading-4">{title}</span>
      {description && <span className={cn('truncate text-xs leading-4 text-muted-foreground', tone && TONE_TEXT[tone])}>{description}</span>}
    </div>
  )
}

const label = <T extends string>(list: { value: T; label: string }[], v: T) => list.find((o) => o.value === v)?.label ?? v

/** A trigger in a few words: `Every Monday at 09:00 in octo/app`, `PR opened in octo/app`. */
function triggerText(t: AutomationTrigger) {
  if (t.kind === 'github') return `${label(EVENTS, t.event)} in ${t.repo || 'a repository'}`
  if (t.kind === 'sentry')
    return `${label(SENTRY_EVENTS, t.event)}${t.event === 'sentry_spike' ? ` (${t.threshold ?? 100}/h)` : ''} in Sentry ${t.project || 'project'}${t.environment ? ` (${t.environment})` : ''}`
  const when = t.every === 'hour' ? `Every hour at :${t.time.slice(3)}` : t.every === 'week' ? `Every ${DAYS[t.day ?? 1]} at ${t.time}` : `${label(EVERY, t.every)} at ${t.time}`
  // A chat's schedule names no repository.
  return t.repo === undefined ? when : `${when} in ${t.repo || 'a repository'}`
}

/** Where an automation stands, for the list and its page. */
function status(a: AutomationView): { text: string; tone: Tone } {
  if (!a.enabled) return { text: 'Paused', tone: 'idle' }
  if (a.problems.length) return { text: `Can’t read ${a.problems[0].repo}`, tone: 'warning' }
  if (a.lastRun?.status === 'failed') return { text: 'Last run failed', tone: 'danger' }
  if (a.nextRunAt) return { text: `Next ${upcoming(a.nextRunAt)}`, tone: 'success' }
  return { text: 'Watching for events', tone: 'success' }
}

// ---------------------------------------------------------------- the list

function NewButton({ variant = 'outline' }: { variant?: 'outline' | 'default' }) {
  return (
    <Button size="sm" variant={variant} nativeButton={false} render={<Link to="/automations" search={{ automation: 'new' }} />}>
      <PlusIcon data-icon="inline-start" />
      New automation
    </Button>
  )
}

/** An automation's mode; an older server sends none for code. */
const modeOf = (a: { mode?: AutomationView['mode'] }) => a.mode ?? 'code'

function AutomationList() {
  // Each workspace has its own automations: code sessions in Agents, chats in Chat. Templates are for code.
  const [workspace] = useAppWorkspace()
  const chat = workspace === 'chat'
  const automations = useAutomations()?.filter((a) => modeOf(a) === (chat ? 'chat' : 'code'))
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = automations?.filter((a) => !q || a.name.toLowerCase().includes(q) || a.triggers.some((t) => triggerText(t).toLowerCase().includes(q)))
  const templates = (chat ? [] : TEMPLATES).filter((t) => !q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RailPage title="Automations">
        {!!automations?.length && <PageRail query={query} onQueryChange={setQuery} placeholder="Search automations…" actions={<NewButton variant="default" />} />}
        <SettingsSections>
          {automations?.length === 0 && (
            <EmptyState
              figure="relay"
              title="No automations yet"
              description={
                chat
                  ? 'A chat that starts on a schedule, or when something happens in a repository or in Sentry.'
                  : 'An agent that runs on a schedule, or when something happens in a repository or in Sentry. Start from a template, or from scratch.'
              }
            >
              <NewButton />
            </EmptyState>
          )}
          {q && !shown?.length && !templates.length && (
            <EmptyState figure="relay" title="No matching automations" description="Try another name, repository or event.">
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
            </EmptyState>
          )}
          {!!shown?.length && (
            <SettingsGroup label="automations">
              {shown.map((a) => {
                const s = status(a)
                return (
                  <Link key={a.id} to="/automations" search={{ automation: a.id }} className={LINK_ROW}>
                    <StatusDot tone={s.tone} />
                    <RowText title={a.name} description={a.triggers.map(triggerText).join(' · ')} />
                    <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block">{a.lastRun ? `Ran ${ago(a.lastRun.createdAt)}` : 'No runs yet'}</span>
                    <span className={cn('w-44 shrink-0 truncate text-end text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
                    <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                )
              })}
            </SettingsGroup>
          )}
          {automations && templates.length > 0 && <Templates templates={templates} />}
        </SettingsSections>
      </RailPage>
    </div>
  )
}

function Templates({ templates }: { templates: AutomationTemplate[] }) {
  return (
    <SettingsSection title="Templates">
      <SettingsGroup label="templates">
        {templates.map((t) => (
          <div key={t.id} className={ROW}>
            <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
              <TriggerMark kind={t.input.triggers[0].kind} />
            </span>
            <RowText title={t.title} description={t.description} />
            <Button size="sm" variant="ghost" nativeButton={false} render={<Link to="/automations" search={{ automation: 'new', template: t.id }} />}>
              Use
            </Button>
          </div>
        ))}
      </SettingsGroup>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------- the form

/** What the owner edits. `enabled` of a saved automation is its own switch, saved at once. */
type Draft = Required<Omit<AutomationInput, 'enabled' | 'triggers'>> & { triggers: AutomationTrigger[] }

const draftOf = (a: AutomationTemplate['input'] | AutomationView): Draft => ({
  mode: modeOf(a),
  name: a.name,
  triggers: a.triggers.map((t) => (t.kind === 'github' ? { ...t, authors: t.authors ?? [] } : { ...t })),
  instructions: a.instructions,
  model: a.model ?? null,
  effort: a.effort ?? null,
  buildId: a.buildId ?? null,
})

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

/** Name, triggers, instructions and the session's model and machine: the settings both a new and a saved automation show. */
function AutomationForm({ draft, setDraft, overview, disabled }: { draft: Draft; setDraft: (d: Draft) => void; overview: ReactNode; disabled?: boolean }) {
  const repos = useGithubRepos()
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  return (
    <>
      {overview}
      <SettingsSection title="Triggers">
        <SettingsGroup label="triggers">
          <TriggerList triggers={draft.triggers} onChange={(triggers) => set({ triggers })} repositories={repos?.repos ?? []} chat={draft.mode === 'chat'} disabled={disabled} />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Instructions" description="Each run also gets what started it: the pull request, issue, comment or Sentry issue.">
        <SettingsGroup label="instructions">
          <Textarea
            aria-label="instructions"
            rows={10}
            disabled={disabled}
            className="max-w-none! min-h-56 rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-6 focus-visible:ring-0 dark:bg-transparent"
            placeholder={draft.mode === 'chat' ? 'Summarize what changed overnight and what needs me today.' : 'Review the pull request and comment with what looks risky.'}
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-1 bg-app/40 px-2 py-1.5">
            <ModelMenu model={draft.model} effort={draft.effort} onChange={(model, effort) => set({ model, effort })} disabled={disabled} />
            <MachineMenu buildId={draft.buildId} onChange={(buildId) => set({ buildId })} disabled={disabled} />
          </div>
        </SettingsGroup>
      </SettingsSection>
    </>
  )
}

const MENU_BUTTON = 'h-7 gap-1 px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3.5'

const EFFORTS: Record<string, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** Claude's model and effort for the sessions it starts: one the agent reported, or the default a new session gets. */
function ModelMenu({ model, effort, onChange, disabled }: { model: string | null; effort: string | null; onChange: (model: string | null, effort: string | null) => void; disabled?: boolean }) {
  const choices = useSettings()?.claudeModels ?? []
  const choice = choices.find((c) => c.model === model)
  const name = choice ? modelLabel(choice) : model ? model : 'Default model'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" className={MENU_BUTTON} disabled={disabled} aria-label="Model" />}>
        {name}
        {effort ? ` · ${EFFORTS[effort] ?? effort}` : ''}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={model ?? ''} onValueChange={(v) => onChange(v || null, null)}>
            <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
            {choices
              .filter((c) => c.model !== 'default')
              .map((c) => (
                <DropdownMenuRadioItem key={c.model} value={c.model}>
                  {modelLabel(c)}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {!!choice?.efforts.length && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ''} onValueChange={(v) => onChange(model, v || null)}>
              <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
              {choice.efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORTS[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The machine sessions start on: the default build, or a built one. */
function MachineMenu({ buildId, onChange, disabled }: { buildId: string | null; onChange: (buildId: string | null) => void; disabled?: boolean }) {
  const builds = useBuilds()
  const built = builds?.filter((b: BuildView) => b.image || b.id === buildId) ?? []
  if (!built.length && !buildId) return null
  const current = built.find((b) => b.id === buildId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" className={MENU_BUTTON} disabled={disabled} aria-label="Machine" />}>
        {current ? current.name : 'Default machine'}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Machine</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={buildId ?? ''} onValueChange={(v) => onChange(v || null)}>
            <DropdownMenuRadioItem value="">Default machine</DropdownMenuRadioItem>
            {built.map((b) => (
              <DropdownMenuRadioItem key={b.id} value={b.id}>
                {b.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const Crumb = () => (
  <Link to="/automations" className="hover:text-foreground">
    Automations
  </Link>
)

// ---------------------------------------------------------------- a new automation

function NewAutomation({ template }: { template?: AutomationTemplate }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  // A new automation is the workspace's: a chat in Chat (starting from a schedule, which needs no repository), else code.
  const [workspace] = useAppWorkspace()
  const [draft, setDraft] = useState<Draft>(() =>
    template
      ? draftOf(template.input)
      : workspace === 'chat'
        ? { mode: 'chat', name: '', triggers: [{ kind: 'schedule', every: 'day', day: 1, time: '09:00', timezone: localTimeZone() }], instructions: '', model: null, effort: null, buildId: null }
        : { mode: 'code', name: '', triggers: [{ kind: 'github', event: 'pr_opened', repo: '', authors: [] }], instructions: '', model: null, effort: null, buildId: null },
  )
  const [enabled, setEnabled] = useState(true)
  const { run, pending, error } = usePending()
  const create = () =>
    run(async () => {
      const { id } = await actions.createAutomation({ ...draft, enabled })
      toast.success('Automation created')
      await navigate({ to: '/automations', search: { automation: id } })
    })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<Crumb />}
        title={draft.name.trim() || 'New automation'}
        titleActions={<ActiveSwitch checked={enabled} onChange={setEnabled} />}
        actions={
          <Button size="sm" disabled={pending} onClick={() => void create()}>
            Create automation
          </Button>
        }
      />
      <Page>
        <AutomationForm
          draft={draft}
          setDraft={setDraft}
          disabled={pending}
          overview={
            <div className="flex flex-col gap-2.5">
              <SettingsGroup label="overview">
                <NameRow chat={draft.mode === 'chat'} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} autoFocus />
              </SettingsGroup>
              <SettingsStatus error={error} />
            </div>
          }
        />
      </Page>
    </div>
  )
}

// ---------------------------------------------------------------- a saved automation

function AutomationPage({ id }: { id: string }) {
  const automation = useAutomation(id)
  if (automation === undefined) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (automation === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader parent={<Crumb />} title="Not found" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="relay" title="This automation no longer exists">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/automations" />}>
              Back to automations
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  return <AutomationDetails automation={automation} />
}

function AutomationDetails({ automation: a }: { automation: AutomationView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const saved = useMemo(() => draftOf(a), [a])
  const [draft, setDraft] = useState<Draft>(saved)
  // A save (here or in another window) moves the saved version; an edit in progress is kept.
  const [base, setBase] = useState(saved)
  useEffect(() => {
    if (same(saved, base)) return
    if (same(draft, base)) setDraft(saved)
    setBase(saved)
  }, [saved, base, draft])
  const dirty = !same(draft, saved)
  const save = usePending()
  const trying = usePending()
  const toggling = usePending()
  const [deleting, setDeleting] = useState(false)
  const runNow = () =>
    trying.run(async () => {
      const r = await actions.runAutomation(a.id)
      toast.success('Run started', r.dork ? { action: { label: 'Open session', onClick: () => void navigate({ to: '/dorks', search: { dork: r.dork!.id } }) } } : undefined)
    })
  useEffect(() => {
    if (trying.error) toast.error(trying.error)
  }, [trying.error])
  useEffect(() => {
    if (toggling.error) toast.error(toggling.error)
  }, [toggling.error])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<Crumb />}
        title={a.name}
        titleActions={<ActiveSwitch checked={a.enabled} disabled={toggling.pending} onChange={(on) => void toggling.run(() => actions.updateAutomation(a.id, { enabled: on }))} />}
        actions={
          <>
            <Button size="sm" variant="outline" disabled={trying.pending} onClick={() => void runNow()}>
              <PlayIcon data-icon="inline-start" />
              Run now
            </Button>
            <Button size="sm" className="ms-1.5" disabled={!dirty || save.pending} onClick={() => void save.run(() => actions.updateAutomation(a.id, draft))}>
              Save
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="ms-0.5" aria-label="More" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                  <Trash2Icon />
                  Delete automation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <Page>
        <AutomationForm
          draft={draft}
          setDraft={setDraft}
          disabled={save.pending}
          overview={
            <div className="flex flex-col gap-2.5">
              <SettingsGroup label="overview">
                <Facts automation={a} />
                <Notices automation={a} />
                <NameRow chat={draft.mode === 'chat'} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
              </SettingsGroup>
              <SettingsStatus error={save.error} />
            </div>
          }
        />
        <RunHistory automation={a} />
      </Page>
      <DeleteDialog automation={a} open={deleting} onOpenChange={setDeleting} />
    </div>
  )
}

/** Active or paused, beside the title: on runs on its triggers; off runs only on Run now. */
function ActiveSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <Tip label={checked ? 'Active: runs on its triggers. Turn off to pause.' : 'Paused: runs only on Run now. Turn on to resume.'}>
      <Switch size="sm" className="ms-2" aria-label="Active" checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Tip>
  )
}

/** The name, edited in place: a compact input, the same 28px as the trigger choices around it. */
function NameRow({ value, onChange, autoFocus, chat }: { value: string; onChange: (name: string) => void; autoFocus?: boolean; chat?: boolean }) {
  return (
    <SettingsInputRow
      id="automation-name"
      label="Name"
      placeholder={chat ? 'Morning briefing' : 'Review pull requests'}
      autoFocus={autoFocus}
      inputClassName="h-7"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Where it stands, at a glance. A failed last run reads in Last run, not twice. */
function Facts({ automation: a }: { automation: AutomationView }) {
  const s = !a.enabled ? { text: 'Paused', tone: 'idle' as const } : a.problems.length ? status(a) : { text: 'Active', tone: 'success' as const }
  return (
    <SettingsFacts
      items={[
        {
          label: 'Status',
          testId: 'automation-status',
          value: (
            <>
              <StatusDot tone={s.tone} />
              <span className={cn('truncate', TONE_TEXT[s.tone])}>{s.text}</span>
            </>
          ),
        },
        {
          label: 'Next run',
          value: a.nextRunAt ? upcoming(a.nextRunAt) : <span className="text-muted-foreground">{a.enabled && a.triggers.some((t) => t.kind !== 'schedule') ? 'On events' : 'None'}</span>,
        },
        {
          label: 'Last run',
          value: a.lastRun ? (
            <span className={cn('truncate', a.lastRun.status !== 'started' && TONE_TEXT[runTone(a.lastRun)])}>
              {a.lastRun.status === 'started' ? ago(a.lastRun.createdAt) : `${a.lastRun.status === 'failed' ? 'Failed' : 'Skipped'} ${ago(a.lastRun.createdAt)}`}
            </span>
          ) : (
            <span className="text-muted-foreground">None yet</span>
          ),
        },
        { label: 'Runs this week', value: a.recentRuns },
      ]}
    />
  )
}

/** What keeps triggers from firing: a repository the GitHub login cannot read, or a public one open to anyone. */
function Notices({ automation: a }: { automation: AutomationView }) {
  const open = a.publicRepos.filter((r) => a.triggers.some((t) => t.kind === 'github' && t.repo.toLowerCase() === r && !t.authors?.length))
  if (!a.problems.length && !open.length) return null
  return (
    <SettingsGroupBody>
      {a.problems.map((p) => (
        <p key={p.repo} className="text-amber-700 dark:text-amber-400">
          {p.repo}: {p.message}
        </p>
      ))}
      {open.length > 0 && (
        <p>
          {open.join(', ')} {open.length === 1 ? 'is' : 'are'} public, so anyone can write there: only events by the people you list start runs. Add their GitHub logins to the trigger.
        </p>
      )}
    </SettingsGroupBody>
  )
}

function DeleteDialog({ automation: a, open, onOpenChange }: { automation: AutomationView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending, error } = usePending()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">Delete {a.name}?</DialogTitle>
          <DialogDescription className="text-sm leading-5">It stops running and its history is gone. Sessions it started stay in the sidebar.</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await actions.deleteAutomation(a.id)
                onOpenChange(false)
                await navigate({ to: '/automations', search: {} })
              })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- run history

const runTone = (r: AutomationRunView): Tone =>
  r.status === 'failed' ? 'danger' : r.status === 'skipped' ? 'warning' : r.dork?.state === 'working' || r.dork?.state === 'creating' ? 'running' : 'success'

const SOURCE: Record<AutomationRunView['source'], string> = {
  schedule: 'Schedule',
  manual: 'Run now',
  pr_opened: 'PR opened',
  pr_pushed: 'PR pushed',
  pr_merged: 'PR merged',
  issue_opened: 'Issue opened',
  comment: 'Comment',
  sentry_issue: 'New Sentry issue',
  sentry_spike: 'Sentry error spike',
  sentry_monitor: 'Sentry monitor failing',
}

const SourceIcon = ({ source }: { source: AutomationRunView['source'] }) =>
  source === 'schedule' ? (
    <ClockIcon className="size-4 text-muted-foreground" />
  ) : source === 'manual' ? (
    <HandIcon className="size-4 text-muted-foreground" />
  ) : source.startsWith('sentry_') ? (
    <SentryMark />
  ) : (
    <GithubMark />
  )

/** The last runs, under the settings. Left out until the first run: Last run already says None yet. */
function RunHistory({ automation: a }: { automation: AutomationView }) {
  const runs = useAutomationRuns(a.id)
  if (!runs?.length) return null
  return (
    <SettingsSection title="Run history">
      <SettingsGroup label="runs">
        {runs.map((r) => {
          const tone = runTone(r)
          return (
            <div key={r.id} className={ROW}>
              <StatusDot tone={tone} />
              <span className="flex w-4 shrink-0 justify-center">
                <SourceIcon source={r.source} />
              </span>
              <RowText
                title={r.dork?.title ?? r.summary}
                description={r.error ?? `${SOURCE[r.source]}${r.source === 'manual' || r.source === 'schedule' ? '' : ` · ${r.summary}`}${r.repo ? ` · ${r.repo}` : ''}`}
                tone={r.error ? tone : undefined}
              />
              <span className="hidden w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums sm:block" title={new Date(r.createdAt).toLocaleString()}>
                {ago(r.createdAt)}
              </span>
              {r.url && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={r.source.startsWith('sentry_') ? 'Open in Sentry' : 'Open on GitHub'}
                  nativeButton={false}
                  render={<a href={r.url} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon />
                </Button>
              )}
              {r.dork ? (
                <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/dorks" search={{ dork: r.dork.id }} />}>
                  Open
                </Button>
              ) : (
                <span className="w-[52px] shrink-0 text-center text-xs text-muted-foreground">{r.status === 'started' ? 'Deleted' : ''}</span>
              )}
            </div>
          )
        })}
      </SettingsGroup>
    </SettingsSection>
  )
}
