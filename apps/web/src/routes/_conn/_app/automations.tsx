import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, ExternalLinkIcon, HandIcon, PlayIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import { modelLabel } from '@dorks/shared'
import type { AutomationInput, AutomationRunView, AutomationTrigger, AutomationView, BuildView } from '@dorks/client'
import { useAutomation, useAutomationRuns, useAutomations, useBuilds, useDorksClient, useGithubRepos, useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { Switch } from '@dorks/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { TAB_CLASS } from '../../../components/PullRequestPanel'
import { DAYS, EVENTS, EVERY, GithubMark, TriggerList } from '../../../components/automations/TriggerEditor'
import { TEMPLATES, type AutomationTemplate } from '../../../components/automations/templates'
import {
  SettingsFacts,
  SettingsGroup,
  SettingsGroupBody,
  SettingsInputRow,
  SettingsRow,
  SettingsSection,
  SettingsSections,
  SettingsStatus,
  StatusDot,
  TONE_TEXT,
  type Tone,
} from '../../../components/settings/kit'
import { usePending } from '../../../lib/pending'
import { ago, upcoming } from '../../../lib/time'

// Automations (docs/automations.md): instructions an agent runs on a schedule, or when something happens in a repository; each run
// starts a session. Three pages on one route, laid out with the settings kit like Builds: the list with templates (`/automations`),
// a new automation (`?automation=new`, from a `&template=`), and an automation's settings and run history (`?automation=<id>&tab=runs`).

type Search = { automation?: string; template?: string; tab?: 'runs' }

export const Route = createFileRoute('/_conn/_app/automations')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.automation === 'string' ? { automation: s.automation } : {}),
    ...(typeof s.template === 'string' ? { template: s.template } : {}),
    ...(s.tab === 'runs' ? { tab: 'runs' as const } : {}),
  }),
  component: Automations,
})

function Automations() {
  const { automation, template, tab } = Route.useSearch()
  if (automation === 'new') return <NewAutomation key={template ?? ''} template={TEMPLATES.find((t) => t.id === template)} />
  if (automation) return <AutomationPage key={automation} id={automation} tab={tab ?? 'settings'} />
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
  const when = t.every === 'hour' ? `Every hour at :${t.time.slice(3)}` : t.every === 'week' ? `Every ${DAYS[t.day ?? 1]} at ${t.time}` : `${label(EVERY, t.every)} at ${t.time}`
  return `${when} in ${t.repo || 'a repository'}`
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

function AutomationList() {
  const automations = useAutomations()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Automations" actions={automations?.length ? <NewButton /> : undefined} />
      <Page>
        {automations?.length === 0 && (
          <EmptyState figure="relay" title="No automations yet" description="An agent that runs on a schedule, or when something happens in a repository. Start from a template, or from scratch.">
            <NewButton />
          </EmptyState>
        )}
        {!!automations?.length && (
          <SettingsSection title="Automations" description="Each run starts a session with the instructions and what triggered it.">
            <SettingsGroup label="automations">
              {automations.map((a) => {
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
          </SettingsSection>
        )}
        {automations && <Templates />}
      </Page>
    </div>
  )
}

function Templates() {
  return (
    <SettingsSection title="Templates" description="A starting point: pick the repository, then adjust the instructions.">
      <SettingsGroup label="templates">
        {TEMPLATES.map((t) => (
          <div key={t.id} className={ROW}>
            <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{t.input.triggers[0].kind === 'schedule' ? <ClockIcon className="size-4" /> : <GithubMark />}</span>
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
      <SettingsSection title="Triggers" description="When it runs. Each run starts a session in the trigger’s repository.">
        <SettingsGroup label="triggers">
          <TriggerList triggers={draft.triggers} onChange={(triggers) => set({ triggers })} repositories={repos?.repos ?? []} disabled={disabled} />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Instructions" description="What the agent does on every run. It is also told what started the run: the pull request, issue or comment.">
        <SettingsGroup label="instructions">
          <Textarea
            aria-label="instructions"
            rows={10}
            disabled={disabled}
            className="max-w-none! min-h-56 rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-6 focus-visible:ring-0 dark:bg-transparent"
            placeholder="Review the pull request and comment with what looks risky."
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-1.5 bg-app/40 px-3 py-2">
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
  const [draft, setDraft] = useState<Draft>(() =>
    template ? draftOf(template.input) : { name: '', triggers: [{ kind: 'github', event: 'pr_opened', repo: '', authors: [] }], instructions: '', model: null, effort: null, buildId: null },
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
                <SettingsInputRow id="automation-name" label="Name" placeholder="Review pull requests" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <SettingsRow
                  label="Active"
                  htmlFor="automation-active"
                  description="Runs whenever a trigger fires. Paused, it runs only when you click Run now."
                  control={<Switch id="automation-active" checked={enabled} onCheckedChange={setEnabled} />}
                />
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

function AutomationPage({ id, tab }: { id: string; tab: 'settings' | 'runs' }) {
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
  return <AutomationDetails automation={automation} tab={tab} />
}

function AutomationDetails({ automation: a, tab }: { automation: AutomationView; tab: 'settings' | 'runs' }) {
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
  const runNow = () =>
    trying.run(async () => {
      const r = await actions.runAutomation(a.id)
      toast.success('Run started', r.dork ? { action: { label: 'Open session', onClick: () => void navigate({ to: '/dorks', search: { dork: r.dork!.id } }) } } : undefined)
    })
  useEffect(() => {
    if (trying.error) toast.error(trying.error)
  }, [trying.error])
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => void navigate({ to: '/automations', search: { automation: a.id, ...(v === 'runs' ? { tab: 'runs' as const } : {}) }, replace: true })}
      className="h-full min-h-0 gap-0"
    >
      <PageHeader
        parent={<Crumb />}
        title={a.name}
        titleActions={
          <TabsList className="ms-2 h-7! gap-0.5 rounded-none bg-transparent p-0">
            <TabsTrigger value="settings" className={TAB_CLASS}>
              Settings
            </TabsTrigger>
            <TabsTrigger value="runs" className={TAB_CLASS}>
              Run history
            </TabsTrigger>
          </TabsList>
        }
        actions={
          <>
            <Button size="sm" variant="ghost" disabled={trying.pending} onClick={() => void runNow()}>
              <PlayIcon data-icon="inline-start" />
              Run now
            </Button>
            {tab === 'settings' && (
              <Button size="sm" disabled={!dirty || save.pending} onClick={() => void save.run(() => actions.updateAutomation(a.id, draft))}>
                Save
              </Button>
            )}
          </>
        }
      />
      <div className="app-main min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 sm:px-6">
          <TabsContent value="settings">
            <SettingsSections>
              <AutomationForm
                draft={draft}
                setDraft={setDraft}
                disabled={save.pending}
                overview={
                  <div className="flex flex-col gap-2.5">
                    <Overview automation={a} name={draft.name} setName={(name) => setDraft({ ...draft, name })} />
                    <SettingsStatus error={save.error} />
                  </div>
                }
              />
              <DeleteSection automation={a} />
            </SettingsSections>
          </TabsContent>
          <TabsContent value="runs">
            <RunHistory automation={a} onRun={() => void runNow()} running={trying.pending} />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}

function Overview({ automation: a, name, setName }: { automation: AutomationView; name: string; setName: (name: string) => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  // The facts beside it say when it runs next; here a healthy automation is simply Active.
  const s = status(a).tone === 'success' ? { text: 'Active', tone: 'success' as const } : status(a)
  return (
    <>
      <SettingsGroup label="overview">
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
              value: a.nextRunAt ? upcoming(a.nextRunAt) : <span className="text-muted-foreground">{a.enabled && a.triggers.some((t) => t.kind === 'github') ? 'On events' : 'None'}</span>,
            },
            {
              label: 'Last run',
              value: a.lastRun ? (
                <Link
                  to="/automations"
                  search={{ automation: a.id, tab: 'runs' }}
                  className={cn('truncate hover:underline hover:underline-offset-4', a.lastRun.status !== 'started' && TONE_TEXT[runTone(a.lastRun)])}
                >
                  {a.lastRun.status === 'started' ? ago(a.lastRun.createdAt) : `${a.lastRun.status === 'failed' ? 'Failed' : 'Skipped'} ${ago(a.lastRun.createdAt)}`}
                </Link>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              ),
            },
            { label: 'Runs this week', value: a.recentRuns },
          ]}
        />
        <Notices automation={a} />
        <SettingsInputRow id="automation-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <SettingsRow
          label="Active"
          htmlFor="automation-active"
          description="Runs whenever a trigger fires. Paused, it runs only when you click Run now."
          control={<Switch id="automation-active" checked={a.enabled} disabled={pending} onCheckedChange={(on) => void run(() => actions.updateAutomation(a.id, { enabled: on }))} />}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </>
  )
}

/** What keeps triggers from firing: a repository the GitHub login cannot read, or a public one open to anyone. */
function Notices({ automation: a }: { automation: AutomationView }) {
  const open = a.publicRepos.filter((r) => a.triggers.some((t) => t.kind === 'github' && t.repo.toLowerCase() === r && !t.authors?.length))
  const failed = a.lastRun?.status === 'failed' ? a.lastRun.error : null
  if (!a.problems.length && !open.length && !failed) return null
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
      {failed && (
        <p role="alert" className="text-destructive">
          The last run failed: {failed}
        </p>
      )}
    </SettingsGroupBody>
  )
}

function DeleteSection({ automation: a }: { automation: AutomationView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Automation">
      <SettingsGroup label="delete automation">
        <SettingsRow
          label="Delete automation"
          description="Stops it and forgets its run history. Sessions it started stay."
          control={
            <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Delete {a.name}?</DialogTitle>
            <DialogDescription className="text-sm leading-5">It stops running and its history is gone. Sessions it started stay in the sidebar.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await actions.deleteAutomation(a.id)
                  setConfirming(false)
                  await navigate({ to: '/automations', search: {} })
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
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
}

const SourceIcon = ({ source }: { source: AutomationRunView['source'] }) =>
  source === 'schedule' ? <ClockIcon className="size-4 text-muted-foreground" /> : source === 'manual' ? <HandIcon className="size-4 text-muted-foreground" /> : <GithubMark />

function RunHistory({ automation: a, onRun, running }: { automation: AutomationView; onRun: () => void; running: boolean }) {
  const runs = useAutomationRuns(a.id)
  if (runs === undefined) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  if (runs.length === 0)
    return (
      <EmptyState figure="relay" title="No runs yet" description="Each run shows up here with the session it started.">
        <Button size="sm" variant="outline" disabled={running} onClick={onRun}>
          Run now
        </Button>
      </EmptyState>
    )
  return (
    <SettingsSections>
      <SettingsSection title="Run history" description="The last 50 runs. Each one started a session, unless it says why not.">
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
                  <Button size="icon-sm" variant="ghost" aria-label="Open on GitHub" nativeButton={false} render={<a href={r.url} target="_blank" rel="noreferrer" />}>
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
    </SettingsSections>
  )
}
