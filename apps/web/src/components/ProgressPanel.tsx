import { useEffect, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CopyIcon, MessageSquareTextIcon } from 'lucide-react'
import { MultiFileDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import { Button } from '@dorks/ui/button'
import { Skeleton } from '@dorks/ui/skeleton'
import {
  progressPick,
  progressSelectedIndex,
  progressSteps,
  progressStore,
  stepEdits,
  stepInputText,
  toolStep,
  useProgress,
  type ProgressStep,
  type ProgressToolBlock,
  type ProgressTurn,
  type StepEdit,
} from '../lib/progress'
import { AgentMarkdown } from './ChatBlock'
import { EmptyState } from './EmptyState'
import { BAR_BUTTON } from './PreviewBrowser'
import { TOOL_KIND_ICONS } from './toolIcons'
import { Tip } from './Tip'
import { WordShimmer } from './WordShimmer'

type IoMode = 'input' | 'output'

/**
 * The chat's progress, in Chat details: one step at a time (a tool call with its input or output in a large island, an edit as its
 * diff), and a bar of the chat's turns, each holding a notch per step, to move through them. It follows a running chat to its newest
 * step until the owner picks another.
 */
export function ProgressPanel({ turns }: { turns: readonly ProgressTurn[] }) {
  const { selectedKey } = useProgress()
  const steps = progressSteps(turns)
  const selectedIndex = progressSelectedIndex(steps, selectedKey)
  const step = steps[selectedIndex]
  const pick = (index: number) => progressStore.select(progressPick(steps, index))

  if (!step) return <EmptyState figure="stack" title="No steps yet" description="Each tool the agent uses in this chat shows here, with what it sent and what came back." />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-[14px] pt-1 pb-3">
      <StepView key={step.key} step={step} />
      <ProgressBar onPick={pick} selectedIndex={selectedIndex} turns={turns} />
      <ProgressFooter onPick={pick} selectedIndex={selectedIndex} step={step} steps={steps} turns={turns} />
    </div>
  )
}

/** The step's title, its Input/Output switch (a diff for an edit), and the island with the chosen side. */
function StepView({ step }: { step: ProgressStep }) {
  const { block } = step
  if (block.kind === 'assistant')
    return (
      <section aria-label="Message" className="flex min-h-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm leading-6">
            <span className="font-medium text-foreground">Said</span>
            <MessageSquareTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </div>
          <CopyButton text={block.text} />
        </div>
        <Island>
          <div className="p-4 text-sm">
            <AgentMarkdown>{block.text}</AgentMarkdown>
          </div>
        </Island>
      </section>
    )
  return <ToolStepView block={block} />
}

function ToolStepView({ block }: { block: ProgressToolBlock }) {
  const edits = stepEdits(block)
  const input = stepInputText(block)
  const output = block.preview
  const running = block.status === 'running'
  // An edit opens on its diff; anything else on its output once there is one, so a running call shows what it sent until its result
  // arrives. A side the owner chose stays.
  const [chosen, setMode] = useState<IoMode | null>(null)
  const mode = chosen ?? (edits.length === 0 && output ? 'output' : 'input')
  const text = mode === 'input' ? input : output
  const showDiff = mode === 'input' && edits.length > 0
  const copyText = showDiff ? edits.map((e) => e.after).join('\n') : text
  const waiting = !text && !showDiff && running

  return (
    <section aria-label="Tool call" className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <StepTitle block={block} />
        <div className="flex shrink-0 items-center gap-1">
          <IoSwitch mode={mode} onChange={setMode} inputLabel={edits.length > 0 ? 'Diff' : 'Input'} />
          <CopyButton text={copyText} />
        </div>
      </div>
      <Island busy={waiting} plain={showDiff}>
        {showDiff ? (
          <EditDiffs edits={edits} />
        ) : text ? (
          <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{text}</pre>
        ) : waiting ? (
          <div className="flex flex-col gap-2 p-4">
            <output className="sr-only">Waiting for the tool</output>
            {[72, 56, 64, 40].map((width) => (
              <Skeleton className="h-3 rounded-(--control-radius) motion-reduce:animate-none" key={width} style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            {input === undefined && mode === 'input' ? 'This step ran before chats kept each tool’s input.' : mode === 'input' ? 'This tool was called with no input.' : 'This tool returned nothing.'}
          </p>
        )}
      </Island>
    </section>
  )
}

/** The large framed area a step's content sits in: the app's fill with a hairline (the fill alone is too close to the panel's). */
function Island({ busy, plain, children }: { busy?: boolean; plain?: boolean; children: React.ReactNode }) {
  return (
    <div aria-busy={busy} className={`relative min-h-0 flex-1 overflow-auto rounded-[8px] border ${plain ? 'bg-background' : 'bg-app'}`}>
      {children}
    </div>
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

/** "Ran", the tool's icon and what it ran, then the tool's own name. */
function StepTitle({ block }: { block: ProgressToolBlock }) {
  const { kind, verb } = toolStep(block.name, block.status)
  const Icon = TOOL_KIND_ICONS[kind]
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-6">
      {block.status === 'running' ? (
        <span className="font-medium">
          <WordShimmer>{verb}</WordShimmer>
        </span>
      ) : (
        <span className={`font-medium ${block.status === 'error' ? 'text-destructive' : 'text-foreground'}`}>{verb}</span>
      )}
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground" title={block.summary}>
        {block.summary}
      </span>
      <code className="rounded-(--control-radius) bg-app px-1.5 font-mono text-xs leading-5 text-muted-foreground">{block.name}</code>
    </div>
  )
}

function IoSwitch({ mode, onChange, inputLabel }: { mode: IoMode; onChange: (mode: IoMode) => void; inputLabel: string }) {
  return (
    <fieldset className="m-0 flex min-w-0 rounded-[8px] border-0 bg-foreground/[0.05] p-0.5">
      <legend className="sr-only">Show</legend>
      {(['input', 'output'] as const).map((side) => (
        <button
          aria-pressed={mode === side}
          className="h-6 rounded-(--control-radius) px-2.5 text-xs leading-4 font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:transition-none motion-reduce:transition-none"
          key={side}
          onClick={() => onChange(side)}
          type="button"
        >
          {side === 'input' ? inputLabel : 'Output'}
        </button>
      ))}
    </fieldset>
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

/**
 * The chat's turns as segments of one bar, each holding a notch per step. Everything up to the step on screen is filled. A native range
 * input lies over it, so pressing or dragging along it, the arrow keys, Home and End all move between steps.
 */
function ProgressBar({ onPick, selectedIndex, turns }: { onPick: (index: number) => void; selectedIndex: number; turns: readonly ProgressTurn[] }) {
  const steps = progressSteps(turns)
  const step = steps[selectedIndex]
  const valueText = step ? `Step ${selectedIndex + 1} of ${steps.length}: ${stepLabel(step)}` : ''

  let index = 0
  return (
    <div className="relative -my-1.5 flex h-6 items-center rounded-[3px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
      <div aria-hidden className="flex h-2 w-full gap-1.5">
        {turns.map((turn) => (
          <div
            // The cells round the turn's ends themselves, so the marker can stand taller than the bar.
            className="group/turn flex min-w-0 gap-px"
            key={turn.key}
            style={{ flexGrow: turn.steps.length, flexBasis: 0 }}
          >
            {turn.steps.map((turnStep) => {
              const stepIndex = index++
              const failed = turnStep.block.kind === 'tool' && turnStep.block.status === 'error'
              const running = turnStep.block.kind === 'tool' ? turnStep.block.status === 'running' : turnStep.block.streaming
              return (
                <span
                  className={[
                    'relative h-full min-w-px flex-1 first:rounded-l-[3px] last:rounded-r-[3px] group-first/turn:first:rounded-l-full group-last/turn:last:rounded-r-full',
                    stepIndex <= selectedIndex ? 'bg-brand' : failed ? 'bg-destructive/30' : 'bg-brand/20 dark:bg-brand/35',
                    running ? 'animate-pulse motion-reduce:animate-none' : '',
                  ].join(' ')}
                  key={turnStep.key}
                >
                  {stepIndex === selectedIndex ? <span className="absolute -top-1 -right-0.5 -bottom-1 w-1 rounded-full bg-brand ring-2 ring-background" /> : null}
                </span>
              )
            })}
          </div>
        ))}
      </div>
      <input
        aria-label="Step"
        aria-valuetext={valueText}
        className="absolute inset-0 m-0 size-full cursor-pointer opacity-0"
        max={steps.length - 1}
        min={0}
        onChange={(event) => onPick(Number(event.currentTarget.value))}
        step={1}
        type="range"
        value={selectedIndex}
      />
    </div>
  )
}

function stepLabel(step: ProgressStep) {
  return step.block.kind === 'tool' ? `${toolStep(step.block.name, step.block.status).verb} ${step.block.summary}` : 'Said'
}

/** Where the step on screen sits (its number and the message it answers), and on the far side, previous and next. */
function ProgressFooter({
  onPick,
  selectedIndex,
  step,
  steps,
  turns,
}: {
  onPick: (index: number) => void
  selectedIndex: number
  step: ProgressStep
  steps: readonly ProgressStep[]
  turns: readonly ProgressTurn[]
}) {
  const turn = turns.find((candidate) => candidate.steps.includes(step))
  return (
    <div className="-mr-[9px] flex min-w-0 items-center gap-4">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          Step {selectedIndex + 1} of {steps.length}
        </span>
        {turn?.prompt ? (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{turn.prompt}</span>
          </>
        ) : null}
      </p>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tip label="Previous step" side="top">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Previous step" disabled={selectedIndex <= 0} onClick={() => onPick(selectedIndex - 1)}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <Tip label="Next step" side="top">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Next step" disabled={selectedIndex >= steps.length - 1} onClick={() => onPick(selectedIndex + 1)}>
            <ArrowRightIcon />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
