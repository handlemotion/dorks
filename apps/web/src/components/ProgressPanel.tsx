import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BracesIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CopyIcon,
  FileDiffIcon,
  ListFilterIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  SearchIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { MultiFileDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@dorks/ui/input-group'
import { Skeleton } from '@dorks/ui/skeleton'
import {
  matchesFilter,
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

type IoMode = 'input' | 'output'

/** Ready filters for the menu beside the search box: each adds its term to the query (or takes it out again). */
const FILTERS = [
  { label: 'Commands', term: 'type:shell' },
  { label: 'Edits', term: 'type:edit' },
  { label: 'Messages', term: 'type:message' },
  { label: 'Failed', term: 'status:failed' },
  { label: 'Hide messages', term: '-type:message' },
]

/**
 * The chat's progress, in Chat details: every step the agent took, grouped under the message it answered. Each prompt is a header
 * that stays pinned while its steps scroll under it; each step is one 24px row (a command in mono, a file by its path, a message by
 * its first line) with a status dot, and opens in place onto its diff, input or output. A search box filters the steps
 * (`type:shell`, `-status:failed`), and the agent's task list sits at the foot. A running chat stays scrolled to its newest step
 * while the owner is at the bottom.
 */
export function ProgressPanel({ turns, tasks = [] }: { turns: readonly ProgressTurn[]; tasks?: readonly ProgressTask[] }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const { selectedKey, reveal } = useProgress()
  const shown = turns.map((turn) => ({ ...turn, steps: query.trim() ? turn.steps.filter((s) => matchesFilter(s.block, query)) : turn.steps })).filter((t) => t.steps.length > 0)
  const count = turns.reduce((n, t) => n + t.steps.length, 0)

  // Follow a running chat: new steps keep the list at its end, unless the owner scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [count])
  // A turn's card in the thread brings its steps into view.
  useEffect(() => {
    if (!selectedKey) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(selectedKey)}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [reveal, selectedKey])

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-[5px] pb-[5px]">
        <InputGroup className="h-[30px] rounded-(--control-radius)">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search or filter steps"
            placeholder="Search or filter (type:shell, -status:failed)…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="text-sm"
          />
          <InputGroupAddon align="inline-end" className="gap-0.5 pr-1">
            {query && (
              <InputGroupButton size="icon-xs" aria-label="Clear the filter" onClick={() => setQuery('')}>
                <XIcon />
              </InputGroupButton>
            )}
            <DropdownMenu>
              <Tip label="Filters">
                <DropdownMenuTrigger render={<InputGroupButton size="icon-xs" aria-label="Filters" />}>
                  <ListFilterIcon />
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
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {shown.length === 0 ? (
          <p className="px-[14px] py-3 text-sm text-muted-foreground">No steps match.</p>
        ) : (
          shown.map((turn) => (
            <section key={turn.key} data-turn-key={turn.key} aria-label={turn.prompt ?? 'Steps'}>
              {/* Pinned while its steps scroll under it, so the message they answer stays in view. */}
              <h3 className="sticky top-0 z-10 flex h-7 items-center gap-2 bg-background px-[14px] text-sm font-normal text-foreground">
                <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate" title={turn.prompt ?? undefined}>
                  {turn.prompt ?? 'Without a message'}
                </span>
              </h3>
              {/* The steps hang off a hairline under the prompt's icon. */}
              <ul className="ml-[20.5px] border-l">
                {turn.steps.map((step) => (
                  <StepRow key={step.key} step={step} open={open.has(step.key)} onToggle={() => toggle(step.key)} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {tasks.length > 0 && <Tasks tasks={tasks} />}
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
  if (block.name === 'Bash') return { text: block.summary, mono: true }
  const kind = toolStep(block.name, block.status).kind
  if (kind === 'read' || kind === 'edit' || kind === 'search') return { text: block.summary, mono: true }
  // A plan's contents are the Tasks at the foot; its row only says it changed.
  if (kind === 'plan') return { text: toolStep(block.name, block.status).verb, mono: false }
  return { text: `${toolStep(block.name, block.status).verb} ${block.summary}`, mono: false }
}

/** One step: icon, its line, a status dot (brand when it ran, red when it failed, pulsing while it runs). It opens onto its detail. */
function StepRow({ step, open, onToggle }: { step: ProgressStep; open: boolean; onToggle: () => void }) {
  const kind = stepKind(step.block)
  const Icon = kind === 'message' ? MessageSquareTextIcon : TOOL_KIND_ICONS[kind]
  const status = stepStatus(step.block)
  const { text, mono } = stepLine(step)
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-6 w-full min-w-0 items-center gap-2 pr-[14px] pl-3 text-left text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] aria-expanded:text-foreground"
      >
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
      </button>
      {open && (
        <div className="py-1.5 pr-[14px] pl-3">
          {step.block.kind === 'assistant' ? (
            <Detail label="Message" title="Said" actions={<CopyButton text={step.block.text} />}>
              <div className="p-3 text-sm">
                <AgentMarkdown>{step.block.text}</AgentMarkdown>
              </div>
            </Detail>
          ) : (
            <ToolDetail block={step.block} />
          )}
        </div>
      )}
    </li>
  )
}

/** A tool step opened: its diff (an edit), input or output, with the toggle between them and Copy. */
function ToolDetail({ block }: { block: ProgressToolBlock }) {
  const edits = stepEdits(block)
  const input = stepInputText(block)
  const output = block.preview
  const running = block.status === 'running'
  // An edit opens on its diff; anything else on its output once there is one. A side the owner chose stays.
  const [chosen, setMode] = useState<IoMode | null>(null)
  const mode = chosen ?? (edits.length === 0 && output ? 'output' : 'input')
  const text = mode === 'input' ? input : output
  const showDiff = mode === 'input' && edits.length > 0
  const copyText = showDiff ? edits.map((e) => e.after).join('\n') : text
  const waiting = !text && !showDiff && running
  return (
    <Detail
      label="Tool call"
      title={
        <>
          {showDiff ? 'Diff' : mode === 'input' ? 'Input' : 'Output'}
          <code className="rounded-(--control-radius) bg-foreground/[0.05] px-1.5 font-mono text-xs leading-5">{block.name}</code>
        </>
      }
      busy={waiting}
      plain={showDiff}
      actions={
        <>
          <IoToggle mode={mode} onChange={setMode} diff={edits.length > 0} />
          <CopyButton text={copyText} />
        </>
      }
    >
      {showDiff ? (
        <EditDiffs edits={edits} />
      ) : text ? (
        <pre className="p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{text}</pre>
      ) : waiting ? (
        <div className="flex flex-col gap-2 p-3">
          <output className="sr-only">Waiting for the tool</output>
          {[72, 56, 40].map((width) => (
            <Skeleton className="h-3 rounded-(--control-radius) motion-reduce:animate-none" key={width} style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : (
        <p className="p-3 text-sm text-muted-foreground">
          {input === undefined && mode === 'input' ? 'This step ran before chats kept each tool’s input.' : mode === 'input' ? 'This tool was called with no input.' : 'This tool returned nothing.'}
        </p>
      )}
    </Detail>
  )
}

/**
 * An opened step: one island (the app's fill with a hairline) whose top row (what it shows, then the toggle and Copy) is split from
 * the content by a full hairline. The content scrolls inside, up to 360px. A diff's content is the page's fill, like Changes.
 */
function Detail({ label, title, actions, busy, plain, children }: { label: string; title: React.ReactNode; actions: React.ReactNode; busy?: boolean; plain?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col overflow-hidden rounded-[8px] border bg-app">
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b pr-[5px] pl-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{title}</span>
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
      <div aria-busy={busy} className={`max-h-90 overflow-auto ${plain ? 'bg-background' : ''}`}>
        {children}
      </div>
    </section>
  )
}

/** The agent's task list at the foot: how far it is (a bar and `3/9 done`), opening onto each task with its state. */
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

/**
 * Input or output, as one icon-only toggle beside Copy (same 30px bar button). Its icon and label name the side it switches to:
 * braces for the input, a file diff for an edit's diff, a terminal for the output.
 */
function IoToggle({ mode, onChange, diff }: { mode: IoMode; onChange: (mode: IoMode) => void; diff: boolean }) {
  const next: IoMode = mode === 'input' ? 'output' : 'input'
  const label = next === 'output' ? 'Show output' : diff ? 'Show diff' : 'Show input'
  const Icon = next === 'output' ? SquareTerminalIcon : diff ? FileDiffIcon : BracesIcon
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label={label} onClick={() => onChange(next)}>
        <Icon />
      </Button>
    </Tip>
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
