import { useState, type ReactNode } from 'react'
import { ChevronDownIcon, ClockIcon, FolderIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { cn } from 'cn'
import type { AutomationTrigger, GithubEvent, GithubTrigger, ScheduleEvery, ScheduleTrigger, SentryEvent, SentryTrigger } from '@dorks/client'
import { useSentryProjects } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Command, CommandEmpty, CommandItem, CommandList, CommandMenuInput, CommandSeparator } from '@dorks/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  MENU_POPUP_CLASS,
} from '@dorks/ui/dropdown-menu'
import { Input } from '@dorks/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import githubDark from '../../assets/providers/github-dark.svg'
import githubLight from '../../assets/providers/github-light.svg'
import { REPO, REPO_ITEM, RepoRow } from '../RepoAvatar'
import { RefreshRepositories } from '../EnvironmentPicker'
import { Logo } from '../onboarding/List'
import { OwnerAvatar, ownerOf } from '../RepoAvatar'
import { localTimeZone } from './templates'

// An automation's triggers, each one sentence with its choices inline (`Every week on Monday at 09:00 in octo/app`), the way a person
// would say it. Choices are 28px chips on a faint fill; a chip that still needs a choice reads in amber.

export const EVERY: { value: ScheduleEvery; label: string }[] = [
  { value: 'hour', label: 'Every hour' },
  { value: 'day', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'week', label: 'Every week' },
]
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const EVENTS: { value: GithubEvent; label: string }[] = [
  { value: 'pr_opened', label: 'PR opened' },
  { value: 'pr_pushed', label: 'PR pushed' },
  { value: 'pr_merged', label: 'PR merged' },
  { value: 'issue_opened', label: 'Issue opened' },
  { value: 'comment', label: 'Comment' },
]
export const SENTRY_EVENTS: { value: SentryEvent; label: string }[] = [
  { value: 'sentry_issue', label: 'New issue' },
  { value: 'sentry_spike', label: 'Error spike' },
  { value: 'sentry_monitor', label: 'Monitor failing' },
]
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

const CHIP =
  'inline-flex h-6 min-w-0 max-w-64 shrink-0 items-center gap-1 rounded-[6px] bg-foreground/[0.05] px-1.5 text-sm text-foreground outline-none transition-colors hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'
const NEEDED = 'text-amber-700 dark:text-amber-400'

/** The GitHub mark, for event triggers. */
export const GithubMark = ({ className }: { className?: string }) => <Logo light={githubLight} dark={githubDark} className={cn('size-4 shrink-0', className)} />

/** Sentry's mark, for Sentry triggers. */
export const SentryMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={cn('size-4 shrink-0 fill-current text-foreground', className)}>
    <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
  </svg>
)

/** The mark for a trigger's kind. */
export const TriggerMark = ({ kind }: { kind: AutomationTrigger['kind'] }) => (kind === 'schedule' ? <ClockIcon className="size-4" /> : kind === 'sentry' ? <SentryMark /> : <GithubMark />)

/** `GMT+7` for a zone, now. */
export function zoneLabel(timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** A short choice from a list, as a chip. */
function ChipMenu<V extends string>({ label, value, options, onChange, disabled }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} aria-label={label} className={CHIP}>
        <span className="truncate">{options.find((o) => o.value === value)?.label ?? value}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 min-w-36">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as V)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A repository from the GitHub login's list, or any `owner/name` typed in. */
export function RepoChip({ repo, onChange, repositories, disabled }: { repo: string; onChange: (repo: string) => void; repositories: string[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const typed = query.trim()
  const q = typed.toLowerCase()
  const matches = repositories.filter((r) => r !== repo && (!q || r.toLowerCase().includes(q))).slice(0, 100)
  const canUseTyped = REPO.test(typed) && !repositories.some((r) => r.toLowerCase() === q) && q !== repo.toLowerCase()
  const choose = (value: string) => {
    onChange(value)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <PopoverTrigger disabled={disabled} aria-label={`Repository: ${repo || 'Choose repository'}`} className={cn(CHIP, !repo && NEEDED)}>
        {repo ? <OwnerAvatar owner={ownerOf(repo)} size={16} className="size-3" /> : <FolderIcon className={NEEDED} />}
        <span className="truncate">{repo || 'Choose repository'}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0`}>
        <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
          <CommandMenuInput aria-label="Search repositories" autoFocus value={query} onValueChange={setQuery} placeholder="Search repositories…" end={<RefreshRepositories />} />
          <CommandList className="max-h-72 p-1">
            <CommandEmpty className="px-2 py-3 text-left text-xs text-muted-foreground">
              {typed ? 'No repositories match. Type a full owner/name to use it, or refresh the list.' : 'Type an owner/name.'}
            </CommandEmpty>
            {canUseTyped && (
              <CommandItem value={`use:${typed}`} onSelect={() => choose(typed)} className={REPO_ITEM}>
                <PlusIcon className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Use {typed}</span>
              </CommandItem>
            )}
            {repo && (!q || repo.toLowerCase().includes(q)) && (
              <>
                <CommandItem value={repo} data-checked="true" onSelect={() => choose(repo)} className={REPO_ITEM}>
                  <RepoRow repo={repo} />
                </CommandItem>
                {matches.length > 0 && <CommandSeparator className="-mx-1 my-1 bg-border" />}
              </>
            )}
            {matches.map((r) => (
              <CommandItem key={r} value={r} onSelect={() => choose(r)} className={REPO_ITEM}>
                <RepoRow repo={r} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Who an event must come from: anyone, or a list of logins. */
function AuthorsChip({ authors, onChange, disabled }: { authors: string[]; onChange: (authors: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState('')
  const label = authors.length === 0 ? 'Anyone' : authors.length === 1 ? `@${authors[0]}` : `${authors.length} people`
  const commit = (value: string) =>
    onChange([
      ...new Set(
        value
          .split(/[\s,]+/)
          .map((l) => l.replace(/^@/, '').trim())
          .filter(Boolean),
      ),
    ])
  return (
    <Popover onOpenChange={(open) => (open ? setText(authors.join(', ')) : commit(text))}>
      <PopoverTrigger disabled={disabled} aria-label={`People: ${label}`} className={CHIP}>
        <span className="truncate">{label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className={`${MENU_POPUP_CLASS} w-80 gap-2 p-3`}>
        <label htmlFor="automation-authors" className="text-xs text-muted-foreground">
          GitHub logins, separated by commas. Leave it empty for anyone.
        </label>
        <Input id="automation-authors" autoFocus placeholder="alice, bob" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit(text)} />
      </PopoverContent>
    </Popover>
  )
}

/** One trigger's sentence and its remove button. */
function TriggerRow({
  trigger,
  onChange,
  onRemove,
  repositories,
  disabled,
}: {
  trigger: AutomationTrigger
  onChange: (t: AutomationTrigger) => void
  onRemove?: () => void
  repositories: string[]
  disabled?: boolean
}) {
  const repo = <RepoChip repo={trigger.repo} onChange={(r) => onChange({ ...trigger, repo: r })} repositories={repositories} disabled={disabled} />
  return (
    <div data-slot="settings-row" className="flex min-h-13 items-start gap-3 py-3.5 ps-4 pe-3">
      <span className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground">
        <TriggerMark kind={trigger.kind} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
        {trigger.kind === 'schedule' ? (
          <ScheduleSentence trigger={trigger} onChange={onChange} repo={repo} disabled={disabled} />
        ) : trigger.kind === 'sentry' ? (
          <SentrySentence trigger={trigger} onChange={onChange} repo={repo} disabled={disabled} />
        ) : (
          <GithubSentence trigger={trigger} onChange={onChange} repo={repo} disabled={disabled} />
        )}
      </div>
      {onRemove && (
        <Button type="button" size="icon-sm" variant="ghost" className="-my-1 text-muted-foreground" aria-label="Remove trigger" disabled={disabled} onClick={onRemove}>
          <Trash2Icon />
        </Button>
      )}
    </div>
  )
}

const Line = ({ children }: { children: ReactNode }) => <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5">{children}</div>
const Word = ({ children }: { children: ReactNode }) => <span className="text-muted-foreground">{children}</span>

function ScheduleSentence({ trigger: t, onChange, repo, disabled }: { trigger: ScheduleTrigger; onChange: (t: ScheduleTrigger) => void; repo: ReactNode; disabled?: boolean }) {
  const [hh, mm] = t.time.split(':')
  return (
    <>
      <Line>
        <ChipMenu label="How often" value={t.every} options={EVERY} onChange={(every) => onChange({ ...t, every })} disabled={disabled} />
        {t.every === 'week' && (
          <>
            <Word>on</Word>
            <ChipMenu label="Day" value={String(t.day ?? 1)} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} onChange={(d) => onChange({ ...t, day: Number(d) })} disabled={disabled} />
          </>
        )}
        <Word>at</Word>
        {t.every === 'hour' ? (
          <ChipMenu label="Minute" value={mm} options={MINUTES.map((m) => ({ value: m, label: `:${m}` }))} onChange={(m) => onChange({ ...t, time: `${hh}:${m}` })} disabled={disabled} />
        ) : (
          <input
            type="time"
            aria-label="Time"
            required
            disabled={disabled}
            value={t.time}
            onChange={(e) => e.target.value && onChange({ ...t, time: e.target.value })}
            className={cn(CHIP, 'w-auto tabular-nums [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:hidden')}
          />
        )}
        <span className="text-muted-foreground" title={t.timezone}>
          {zoneLabel(t.timezone)}
        </span>
      </Line>
      <Line>
        <Word>in</Word>
        {repo}
        <Word>from</Word>
        <input
          aria-label="Branch"
          disabled={disabled}
          placeholder="default branch"
          spellCheck={false}
          value={t.branch ?? ''}
          onChange={(e) => onChange({ ...t, branch: e.target.value || undefined })}
          className={cn(CHIP, 'w-32 font-mono text-xs placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground')}
        />
      </Line>
    </>
  )
}

function GithubSentence({ trigger: t, onChange, repo, disabled }: { trigger: GithubTrigger; onChange: (t: GithubTrigger) => void; repo: ReactNode; disabled?: boolean }) {
  return (
    <Line>
      <ChipMenu label="Event" value={t.event} options={EVENTS} onChange={(event) => onChange({ ...t, event })} disabled={disabled} />
      <Word>in</Word>
      {repo}
      <Word>by</Word>
      <AuthorsChip authors={t.authors ?? []} onChange={(authors) => onChange({ ...t, authors })} disabled={disabled} />
    </Line>
  )
}

/** A Sentry project of the connected organization, or any slug typed in. */
function ProjectChip({ project, onChange, disabled }: { project: string; onChange: (project: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const sentry = useSentryProjects()
  const slugs = sentry?.projects.map((p) => p.slug) ?? []
  const typed = query.trim().toLowerCase()
  const matches = slugs.filter((s) => s !== project && (!typed || s.includes(typed))).slice(0, 100)
  const canUseTyped = /^[a-z0-9][a-z0-9_-]*$/.test(typed) && !slugs.includes(typed) && typed !== project
  const choose = (value: string) => {
    onChange(value)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <PopoverTrigger disabled={disabled} aria-label={`Sentry project: ${project || 'Choose project'}`} className={cn(CHIP, !project && NEEDED)}>
        <span className="truncate">{project || 'Choose project'}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className={`${MENU_POPUP_CLASS} w-72 gap-0 p-0`}>
        <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
          <CommandMenuInput aria-label="Search Sentry projects" autoFocus value={query} onValueChange={setQuery} placeholder="Search projects…" />
          <CommandList className="max-h-72 p-1">
            <CommandEmpty className="px-2 py-3 text-left text-xs text-muted-foreground">
              {sentry?.error ?? (typed ? 'No projects match. Type a full slug to use it.' : 'Type a project slug.')}
            </CommandEmpty>
            {canUseTyped && (
              <CommandItem value={`use:${typed}`} onSelect={() => choose(typed)} className={REPO_ITEM}>
                <PlusIcon className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Use {typed}</span>
              </CommandItem>
            )}
            {project && (!typed || project.includes(typed)) && (
              <CommandItem value={project} data-checked="true" onSelect={() => choose(project)} className={REPO_ITEM}>
                <span className="min-w-0 flex-1 truncate">{project}</span>
              </CommandItem>
            )}
            {matches.map((s) => (
              <CommandItem key={s} value={s} onSelect={() => choose(s)} className={REPO_ITEM}>
                <span className="min-w-0 flex-1 truncate">{s}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function SentrySentence({ trigger: t, onChange, repo, disabled }: { trigger: SentryTrigger; onChange: (t: SentryTrigger) => void; repo: ReactNode; disabled?: boolean }) {
  return (
    <>
      <Line>
        <ChipMenu label="Sentry event" value={t.event} options={SENTRY_EVENTS} onChange={(event) => onChange({ ...t, event })} disabled={disabled} />
        <Word>in</Word>
        <ProjectChip project={t.project} onChange={(project) => onChange({ ...t, project })} disabled={disabled} />
        <input
          aria-label="Environment"
          disabled={disabled}
          placeholder="all environments"
          spellCheck={false}
          value={t.environment ?? ''}
          onChange={(e) => onChange({ ...t, environment: e.target.value.trim() || undefined })}
          className={cn(CHIP, 'w-36 placeholder:text-muted-foreground')}
        />
        {t.event === 'sentry_spike' && (
          <>
            <Word>at</Word>
            <input
              type="number"
              aria-label="Events in an hour"
              min={1}
              disabled={disabled}
              value={t.threshold ?? 100}
              onChange={(e) => onChange({ ...t, threshold: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              className={cn(CHIP, 'w-20 tabular-nums')}
            />
            <Word>events an hour</Word>
          </>
        )}
      </Line>
      <Line>
        <Word>working in</Word>
        {repo}
      </Line>
    </>
  )
}

/** A new trigger of a kind, in the repository the automation already uses. */
function newTrigger(kind: 'schedule' | GithubEvent | SentryEvent, repo: string): AutomationTrigger {
  if (kind === 'schedule') return { kind: 'schedule', every: 'day', day: 1, time: '09:00', timezone: localTimeZone(), repo }
  if (kind.startsWith('sentry_')) return { kind: 'sentry', event: kind as SentryEvent, project: '', threshold: 100, repo }
  return { kind: 'github', event: kind as GithubEvent, repo, authors: [] }
}

/** The triggers' rows, then Add trigger. */
export function TriggerList({ triggers, onChange, repositories, disabled }: { triggers: AutomationTrigger[]; onChange: (t: AutomationTrigger[]) => void; repositories: string[]; disabled?: boolean }) {
  const add = (kind: 'schedule' | GithubEvent | SentryEvent) => onChange([...triggers, newTrigger(kind, triggers.at(-1)?.repo ?? '')])
  return (
    <>
      {triggers.map((t, i) => (
        <TriggerRow
          // Triggers have no ids: their place is who they are, and removing one remounts the rest.
          key={`${i}:${triggers.length}`}
          trigger={t}
          repositories={repositories}
          disabled={disabled}
          onChange={(next) => onChange(triggers.map((x, j) => (j === i ? next : x)))}
          onRemove={triggers.length > 1 ? () => onChange(triggers.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <div className="flex items-center py-1.5 ps-2 pe-3 [&_button]:h-7">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" disabled={disabled || triggers.length >= 10} className="text-muted-foreground" />}>
            <PlusIcon data-icon="inline-start" />
            Add trigger
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => add('schedule')}>
                <ClockIcon />
                On a schedule
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuGroup>
              <DropdownMenuLabel>GitHub</DropdownMenuLabel>
              {EVENTS.map((e) => (
                <DropdownMenuItem key={e.value} onClick={() => add(e.value)}>
                  <GithubMark />
                  {e.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sentry</DropdownMenuLabel>
              {SENTRY_EVENTS.map((e) => (
                <DropdownMenuItem key={e.value} onClick={() => add(e.value)}>
                  <SentryMark />
                  {e.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
