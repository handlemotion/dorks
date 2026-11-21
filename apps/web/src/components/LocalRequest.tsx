import { createContext, useContext, type ReactNode } from 'react'
import { FileTextIcon, LaptopIcon, ShieldCheckIcon, ShieldXIcon, TerminalIcon, TimerOffIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import type { LocalDecision } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { usePending } from '../lib/pending'

// An agent's request to use the owner's own computer (docs/local-access.md). The owner is asked once per session: the first request is
// a compact card ("Claude wants to access your computer", the agent's reason, Allow for this session / Always allow / Deny). Every
// command or read after that, and the first one once answered, is one line in the thread whose output folds open under it.

type LocalBlock = Extract<Block, { kind: 'local' }>

/** The dork the transcript belongs to, so a card can answer for it. Without it (demos) the cards are read-only. */
const LocalAccessContext = createContext<{ dorkId: string; agent: string } | null>(null)

export function LocalAccessProvider({ dorkId, agent, children }: { dorkId: string; agent: string; children: ReactNode }) {
  return <LocalAccessContext.Provider value={{ dorkId, agent }}>{children}</LocalAccessContext.Provider>
}

const target = (block: LocalBlock) => (block.request === 'run' ? block.command : block.path) ?? ''

export function LocalRequestCard({ block }: { block: LocalBlock }) {
  const agent = useContext(LocalAccessContext)?.agent ?? 'The agent'
  if (block.status === 'pending') return <AccessPrompt block={block} agent={agent} />
  return (
    <Trace data-testid="local-request" data-status={block.status} className="my-1.5 gap-2">
      {block.via === 'session' || block.via === 'always' ? (
        <TraceLine role="status" className="text-(length:--text-message)">
          <TraceIcon>
            <ShieldCheckIcon />
          </TraceIcon>
          <TraceTitle>{block.via === 'session' ? `You allowed ${agent} to access your computer in this session` : 'You allowed every session to access your computer'}</TraceTitle>
        </TraceLine>
      ) : null}
      <LocalLine block={block} />
    </Trace>
  )
}

/** The one question a session asks: may it use this computer at all. What it asked to do first and why stay visible. */
function AccessPrompt({ block, agent }: { block: LocalBlock; agent: string }) {
  const ctx = useContext(LocalAccessContext)
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const answer = (decision: LocalDecision['decision']) => ctx && void run(() => actions.decideLocal(ctx.dorkId, block.requestId, { decision }))
  // The surface fill with its hairline, as Settings raises a group; one padded block, no inner lines.
  return (
    <div role="alert" data-testid="local-request" data-status="pending" className="flex w-full min-w-0 flex-col gap-3 rounded-[6px] border border-surface-line bg-surface px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2.5 text-sm text-foreground">
          <LaptopIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{agent} wants to access your computer</span>
        </p>
        <p className="pl-6.5 text-sm text-muted-foreground">{block.reason}</p>
        <p className="truncate pl-6.5 font-mono text-xs text-muted-foreground" title={target(block)}>
          {block.request === 'run' ? `First: ${target(block)}${block.cwd ? ` in ${block.cwd}` : ''}` : `First: read ${target(block)}`}
        </p>
      </div>
      {ctx && (
        <div className="flex flex-wrap gap-2 pl-6.5">
          <Button size="sm" disabled={pending} onClick={() => answer('session')}>
            Allow for this session
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => answer('always')}>
            Always allow
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => answer('deny')}>
            Deny
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="pl-6.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function lineTitle(block: LocalBlock): string {
  const run = block.request === 'run'
  switch (block.status) {
    case 'denied':
      return 'You declined access to your computer'
    case 'expired':
      return 'The request to access your computer was not answered in time'
    case 'pending':
    case 'allowed':
      return run ? `Running on your computer: ${target(block)}` : `Reading on your computer: ${target(block)}`
    case 'done':
      return run ? `Ran on your computer: ${target(block)}` : `Read on your computer: ${target(block)}`
    case 'failed':
      return run ? `Failed on your computer${block.exitCode ? ` (exit ${block.exitCode})` : ''}: ${target(block)}` : `Could not read on your computer: ${target(block)}`
  }
}

/** One command or read, in one line at the thread's 14px; its output folds open under it. */
function LocalLine({ block }: { block: LocalBlock }) {
  const agent = useContext(LocalAccessContext)?.agent ?? 'The agent'
  const title = lineTitle(block)
  const icon = block.status === 'denied' ? <ShieldXIcon /> : block.status === 'expired' ? <TimerOffIcon /> : block.request === 'run' ? <TerminalIcon /> : <FileTextIcon />
  const line = (
    <TraceLine
      status={block.status === 'allowed' ? 'running' : block.status === 'failed' ? 'error' : undefined}
      className="text-(length:--text-message) in-[button:hover]:text-foreground/65"
      title={block.status === 'denied' || block.status === 'expired' ? block.reason : title}
    >
      <TraceIcon>{icon}</TraceIcon>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  )
  if (!block.preview) return line
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={block.status === 'failed' ? 'destructive' : 'default'}>
          <CodeBlockContent wrap className="max-h-64">
            {block.preview}
          </CodeBlockContent>
        </CodeBlock>
        {block.truncated && <p className="pt-1 text-xs">Only the end is shown here; {agent} got the whole result.</p>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
