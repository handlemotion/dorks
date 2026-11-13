import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CopyIcon,
  ListFilterIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { MultiFileDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@dorks/ui/input-group'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { Skeleton } from '@dorks/ui/skeleton'
import {
  matchesFilter,
  progressStore,
  stepEdits,
  stepInputText,
  stepKind,
  stepStatus,
  toolStep,
  useProgress,
  type ProgressStep,
  type ProgressTask,
  type ProgressToolBlock,
  type ProgressTurn,
  type StepEdit,
} from '../lib/progress'
import { AgentMarkdown } from './ChatBlock'
import { EmptyState } from './EmptyState'
import { BAR_BUTTON } from './PreviewBrowser'
import { TOOL_KIND_ICONS } from './toolIcons'
import { Tip } from './Tip'

/** Ready filters for the menu beside the search box: each adds its term to the query (or takes it out again). */
const FILTERS = [
  { label: 'Commands', term: 'type:shell' },
  { label: 'Edits', term: 'type:edit' },
  { label: 'Messages', term: 'type:message' },
  { label: 'Failed', term: 'status:failed' },
  { label: 'Hide messages', term: '-type:message' },
]

const DETAIL_KEY = 'dorks.progress-detail-size'

/**
 * The detail's height, remembered per browser like every resizable panel's. It is kept apart from the group's layout: the detail only
 * mounts when a step is selected, so a layout saved without it (the steps alone, at 100%) must not wipe it.
 */
function savedDetailSize(): string {
  try {
    const n = Number(localStorage.getItem(DETAIL_KEY))
    return n > 0 && n < 100 ? `${n}%` : '45%'
  } catch {
    return '45%'
  }
}

function saveDetailSize(size: number | undefined) {
  if (size === undefined) return
  try {
    localStorage.setItem(DETAIL_KEY, String(size))
  } catch {
    /* private mode: keep the default */
  }
}

/** The search box's buttons: 24px, the controls' 6px radius. */
const ADDON_BUTTON = 'rounded-(--control-radius)'

/** "now", "4m", "2h", "3d": how long ago a step ran, for its row. */
function ago(at: number | undefined, now: number) {
  if (at === undefined) return ''
  const m = Math.floor((now - at) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** A minute clock, so the rows' "4m" moves on without a render each second. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/**
 * The chat's progress, in Chat details: every step the agent took, grouped under the message it answered. Each prompt is a header
 * that stays pinned while its steps scroll under it; each step is one 24px row (a command or path in mono, a message by its first
 * line) with a status dot and how long ago it ran. Selecting a step opens its detail in a resizable lower panel (its input or diff, and its output);
 * with nothing selected (Escape) the foot shows the agent's tasks. A search box filters the steps (`type:shell`, `-status:failed`).
 * A running chat stays scrolled to its newest step while the owner is at the bottom; Play beside the filter also selects each new step
 * as it lands, until the owner picks one.
 */
export function ProgressPanel({ turns, tasks = [] }: { turns: readonly ProgressTurn[]; tasks?: readonly ProgressTask[] }) {
  const [query, setQuery] = useState('')
  // Live: Progress follows the agent, selecting each new step as it lands (its detail open at the foot). Picking a step pauses it.
  const [live, setLive] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const now = useNow()
  const { selectedKey, reveal } = useProgress()
  const shown = turns.map((turn) => ({ ...turn, steps: query.trim() ? turn.steps.filter((s) => matchesFilter(s.block, query)) : turn.steps })).filter((t) => t.steps.length > 0)
  const visible = shown.flatMap((t) => t.steps)
  const count = turns.reduce((n, t) => n + t.steps.length, 0)
  const selectedIndex = visible.findIndex((s) => s.key === selectedKey)
  const selected = visible[selectedIndex]

  // Follow a running chat: new steps keep the list at its end, unless the owner scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [count])
  // A turn's card in the thread brings its steps into view.
  useEffect(() => {
    if (!selectedKey) return
    scroller.current?.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'start' })
  }, [reveal]) // eslint-disable-line react-hooks/exhaustive-deps -- only when the thread asks, not on every pick
  // The selected row stays in view as the arrows move it (a clicked row is already in view: the list stays where it is).
  const clicked = useRef(false)
  useEffect(() => {
    if (clicked.current) return void (clicked.current = false)
    if (selectedKey) scroller.current?.querySelector<HTMLElement>(`[data-step-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  const latestKey = turns.at(-1)?.steps.at(-1)?.key
  useEffect(() => {
    if (!live || !latestKey) return
    progressStore.select(latestKey)
    atEnd.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live, latestKey])
  const select = (key: string | null) => {
    setLive(false)
    progressStore.select(key)
  }
  const pick = (index: number) => {
    const step = visible[Math.max(0, Math.min(index, visible.length - 1))]
    if (step) select(step.key)
  }
  const toggleTerm = (term: string) =>
    setQuery((q) =>
      q.split(/\s+/).includes(term)
        ? q
            .split(/\s+/)
            .filter((t) => t && t !== term)
            .join(' ')
        : `${q.trim()} ${term}`.trim(),
    )

  if (count === 0) return <EmptyState figure="stack" title="No steps yet" description="Each tool the agent uses in this chat shows here, under the message it answered." />
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('input, [role=menu]')) return
        if (e.key === 'Escape' && selected) {
          e.preventDefault()
          select(null)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          pick(selectedIndex < 0 ? (e.key === 'ArrowDown' ? 0 : visible.length - 1) : selectedIndex + (e.key === 'ArrowDown' ? 1 : -1))
        }
      }}
    >
      <div className="shrink-0 px-[5px] pb-[5px]">
        {/* Icons in line with the tab icons above: the search icon 14px from the panel edge, the last button centred under the hide button. */}
        <InputGroup className="h-[30px] rounded-(--control-radius)">
          <InputGroupAddon className="pl-2">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search or filter steps"
            placeholder="Search or filter (type:shell, -status:failed)…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="text-sm"
          />
          <InputGroupAddon align="inline-end" className="gap-0.5 pr-[6px]">
            {query && (
              <InputGroupButton size="icon-xs" className={ADDON_BUTTON} aria-label="Clear the filter" onClick={() => setQuery('')}>
                <XIcon className="size-3.5" />
              </InputGroupButton>
            )}
            <Tip label={live ? 'Pause' : 'Follow the latest step'}>
              <InputGroupButton
                size="icon-xs"
                className={`${ADDON_BUTTON} ${live ? 'text-brand hover:text-brand' : ''}`}
                aria-label={live ? 'Pause' : 'Follow the latest step'}
                aria-pressed={live}
                onClick={() => setLive(!live)}
              >
                {live ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              </InputGroupButton>
            </Tip>
            <DropdownMenu>
              <Tip label="Filters">
                <DropdownMenuTrigger render={<InputGroupButton size="icon-xs" className={ADDON_BUTTON} aria-label="Filters" />}>
                  <ListFilterIcon className="size-3.5" />
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Show</DropdownMenuLabel>
                  {FILTERS.map((f) => (
                    <DropdownMenuItem key={f.term} onClick={() => toggleTerm(f.term)}>
                      <span className="flex-1">{f.label}</span>
                      {query.split(/\s+/).includes(f.term) && <CheckIcon />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </InputGroupAddon>
        </InputGroup>
      </div>
      {/* The steps are always the group's first panel, so selecting one never remounts the list (its scroll stays). */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={(sizes) => saveDetailSize(sizes.detail)}>
        <ResizablePanel id="steps" minSize={96}>
          <div
            ref={scroller}
            role="listbox"
            aria-label="Steps"
            tabIndex={0}
            aria-activedescendant={selected ? `step-${selected.key}` : undefined}
            onScroll={(e) => {
              const el = e.currentTarget
              atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className="h-full overflow-y-auto pb-2 outline-none"
          >
            {shown.length === 0 ? (
              <p className="px-[14px] py-3 text-sm text-muted-foreground">No steps match.</p>
            ) : (
              shown.map((turn) => (
                <div key={turn.key} role="group" data-turn-key={turn.key} aria-label={turn.prompt ?? 'Steps'}>
                  {/* Pinned while its steps scroll under it, so the message they answer stays in view. */}
                  <div className="sticky top-0 z-10 flex h-7 items-center gap-2 bg-background px-[14px] text-sm text-foreground">
                    <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={turn.prompt ?? undefined}>
                      {turn.prompt ?? 'Without a message'}
                    </span>
                  </div>
                  {/* The steps hang off a hairline under the prompt's icon. */}
                  <div className="ml-[20.5px] border-l">
                    {turn.steps.map((step) => (
                      <StepRow
                        key={step.key}
                        step={step}
                        now={now}
                        selected={step.key === selectedKey}
                        onSelect={() => {
                          clicked.current = step.key !== selectedKey
                          // Opening the detail lays the list out again, which drops its scroll: put it back once that settles.
                          const el = scroller.current
                          const top = el?.scrollTop ?? 0
                          select(step.key)
                          if (el && !selected) requestAnimationFrame(() => requestAnimationFrame(() => (el.scrollTop = top)))
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </ResizablePanel>
        {selected && (
          <>
            {/* The divider is the detail's top edge: a full hairline, draggable along a wider band. */}
            <ResizableHandle aria-label="Resize steps and detail" className="after:h-3!" />
            <ResizablePanel id="detail" defaultSize={savedDetailSize()} minSize={120}>
              <StepDetail
                key={selected.key}
                step={selected}
                onPrevious={selectedIndex > 0 ? () => pick(selectedIndex - 1) : undefined}
                onNext={selectedIndex < visible.length - 1 ? () => pick(selectedIndex + 1) : undefined}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {!selected && tasks.length > 0 && <Tasks tasks={tasks} />}
    </div>
  )
}

/** A step's one line: what it ran, read, edited or said. */
function stepLine(step: ProgressStep): { text: string; mono: boolean } {
  const { block } = step
  if (block.kind === 'assistant')
    return {
      text:
        block.text
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .split('\n')
          .find((l) => l.trim()) ?? 'Said',
      mono: false,
    }
  const kind = toolStep(block.name, block.status).kind
  if (kind === 'command' || kind === 'read' || kind === 'edit' || kind === 'search') return { text: block.summary, mono: true }
  // A plan's contents are the Tasks at the foot; its row only says it changed.
  if (kind === 'plan') return { text: toolStep(block.name, block.status).verb, mono: false }
  return { text: `${toolStep(block.name, block.status).verb} ${block.summary}`, mono: false }
}

/** A step's title in its detail: "Ran pnpm test", "Edited src/index.ts", "Said". */
function stepTitle(step: ProgressStep) {
  const { block } = step
  if (block.kind === 'assistant') return 'Said'
  const { kind, verb } = toolStep(block.name, block.status)
  return kind === 'plan' ? verb : `${verb} ${block.summary}`
}

/**
 * One step: icon, its line, a status dot (brand when it ran, red when it failed, pulsing while it runs) and how long ago it ran.
 * Selected, it takes a fill and a brand mark on the hairline it hangs from.
 */
function StepRow({ step, now, selected, onSelect }: { step: ProgressStep; now: number; selected: boolean; onSelect: () => void }) {
  const kind = stepKind(step.block)
  const Icon = kind === 'message' ? MessageSquareTextIcon : TOOL_KIND_ICONS[kind]
  const status = stepStatus(step.block)
  const { text, mono } = stepLine(step)
  return (
    <div
      id={`step-${step.key}`}
      role="option"
      aria-selected={selected}
      data-step-key={step.key}
      onClick={onSelect}
      className={`relative flex h-6 w-full min-w-0 cursor-default items-center gap-2 pr-[14px] pl-3 text-left ${selected ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'}`}
    >
      {selected && <span aria-hidden className="absolute top-0 -left-px h-full w-0.5 bg-brand" />}
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className={`min-w-0 flex-1 truncate ${mono ? 'font-mono text-xs' : 'text-sm'} ${status === 'failed' ? 'text-destructive' : ''}`} title={text}>
        {text}
      </span>
      {kind !== 'message' && (
        <span
          role="img"
          aria-label={status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : 'Done'}
          className={`size-1.5 shrink-0 rounded-full ${status === 'failed' ? 'bg-destructive' : 'bg-brand'} ${status === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        />
      )}
      <span className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{ago(step.block.at, now)}</span>
    </div>
  )
}

/**
 * The selected step, in the lower panel: a bar with its title, the time it ran, and previous and next; under it, its input (an
 * edit's diff) and its output, each a labelled section with Copy, split by full hairlines like the bar above.
 */
function StepDetail({ step, onPrevious, onNext }: { step: ProgressStep; onPrevious?: () => void; onNext?: () => void }) {
  const time = step.block.at ? new Date(step.block.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : undefined
  return (
    <section aria-label="Step detail" className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-[5px] pl-[14px]">
        <h3 className="min-w-0 flex-1 truncate text-sm font-normal" title={stepTitle(step)}>
          {stepTitle(step)}
        </h3>
        {time && <span className="mr-1 text-xs text-muted-foreground tabular-nums">{time}</span>}
        <BarButton label="Previous step" onClick={onPrevious}>
          <ChevronUpIcon />
        </BarButton>
        <BarButton label="Next step" onClick={onNext}>
          <ChevronDownIcon />
        </BarButton>
      </div>
      <div className="min-h-0 flex-1 divide-y overflow-y-auto">
        {step.block.kind === 'assistant' ? (
          <Part label="Message" copy={step.block.text}>
            <div className="px-[14px] pb-3 text-sm">
              <AgentMarkdown>{step.block.text}</AgentMarkdown>
            </div>
          </Part>
        ) : (
          <ToolParts block={step.block} />
        )}
      </div>
    </section>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Tip label={label} side="top">
      <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label={label} disabled={!onClick} onClick={onClick}>
        {children}
      </Button>
    </Tip>
  )
}

/** A tool step's input (an edit's diff instead) and its output, one section each. */
function ToolParts({ block }: { block: ProgressToolBlock }) {
  const edits = stepEdits(block)
  const input = stepInputText(block)
  const output = block.preview
  const running = block.status === 'running'
  return (
    <>
      {edits.length > 0 ? (
        <Part label="Diff" copy={edits.map((e) => e.after).join('\n')} plain>
          <EditDiffs edits={edits} />
        </Part>
      ) : (
        <Part label={block.name === 'Bash' ? 'Command' : 'Input'} copy={input}>
          {input ? <Pre>{input}</Pre> : <Note>{input === undefined ? 'This step ran before chats kept each tool’s input.' : 'This tool was called with no input.'}</Note>}
        </Part>
      )}
      <Part label="Output" copy={output}>
        {output ? (
          <Pre>{output}</Pre>
        ) : running ? (
          <div className="flex flex-col gap-2 px-[14px] pb-3">
            <output className="sr-only">Waiting for the tool</output>
            {[72, 56, 40].map((width) => (
              <Skeleton className="h-3 rounded-(--control-radius) motion-reduce:animate-none" key={width} style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : (
          <Note>This tool returned nothing.</Note>
        )}
      </Part>
    </>
  )
}

const Pre = ({ children }: { children: string }) => <pre className="px-[14px] pb-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</pre>
const Note = ({ children }: { children: string }) => <p className="px-[14px] pb-3 text-sm text-muted-foreground">{children}</p>

/**
 * A section of the detail: a 40px label row with Copy (its icon in line with the bar's buttons), then the content; sections are split
 * by full hairlines. A diff takes its own hairline under the label, since it paints its own fill.
 */
function Part({ label, copy, plain, children }: { label: string; copy?: string; plain?: boolean; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <div className={`flex h-10 items-center pr-[5px] pl-[14px] text-xs text-muted-foreground ${plain ? 'border-b' : ''}`}>
        <span className="flex-1">{label}</span>
        <CopyButton text={copy} />
      </div>
      {children}
    </section>
  )
}

/** The agent's task list at the foot (when no step is selected): how far it is (a bar and `3/9 done`), opening onto each task. */
function Tasks({ tasks }: { tasks: readonly ProgressTask[] }) {
  const [open, setOpen] = useState(true)
  const done = tasks.filter((t) => t.status === 'completed').length
  return (
    <section aria-label="Tasks" className="shrink-0 border-t">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full items-center gap-2 px-[14px] text-left text-sm outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]"
      >
        <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1">Tasks</span>
        <span aria-hidden className="h-1 w-24 overflow-hidden rounded-full bg-brand/20 dark:bg-brand/35">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${(done / tasks.length) * 100}%` }} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {done}/{tasks.length} done
        </span>
        <ChevronRightIcon aria-hidden className={`size-3.5 shrink-0 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <ol className="max-h-40 overflow-y-auto pb-2">
          {tasks.map((task, i) => (
            <li key={i} className="flex h-7 items-center gap-2 px-[14px] text-sm">
              {task.status === 'completed' ? (
                <CircleCheckIcon aria-label="Done" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : task.status === 'in_progress' ? (
                <CircleDotIcon aria-label="In progress" className="size-3.5 shrink-0 text-brand" />
              ) : (
                <CircleIcon aria-label="To do" className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={`min-w-0 truncate ${task.status === 'completed' ? 'text-muted-foreground' : ''}`} title={task.content}>
                <span className="text-muted-foreground tabular-nums">#{i + 1}</span> {task.content}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** An edit's diff, one per change in it (Pierre diffs, unified, no file header: the title already names the file). */
function EditDiffs({ edits }: { edits: StepEdit[] }) {
  const { resolvedTheme } = useTheme()
  return (
    <div className="divide-y">
      {edits.map((edit, i) => (
        <MultiFileDiff
          key={i}
          oldFile={{ name: edit.path, contents: edit.before }}
          newFile={{ name: edit.path, contents: edit.after }}
          className="block [--diffs-bg:var(--background)] [--diffs-font-family:var(--font-mono)] [--diffs-font-size:12px] [--diffs-header-font-family:var(--font-sans)] [--diffs-line-height:20px]"
          options={{ diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap', themeType: resolvedTheme === 'dark' ? 'dark' : 'light' }}
        />
      ))}
    </div>
  )
}

function CopyButton({ text }: { text: string | undefined }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1_200)
    return () => window.clearTimeout(timeout)
  }, [copied])
  return (
    <Tip label={copied ? 'Copied' : 'Copy'}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={BAR_BUTTON}
        aria-label={copied ? 'Copied' : 'Copy'}
        disabled={!text}
        onClick={() => {
          if (!text) return
          navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            // Clipboard access can be unavailable in an insecure or restricted context.
            .catch(() => undefined)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </Tip>
  )
}
