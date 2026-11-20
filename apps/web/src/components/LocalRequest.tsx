import { createContext, useContext, type ReactNode } from 'react'
import { FileTextIcon, LaptopIcon, ShieldCheckIcon, ShieldXIcon, TerminalIcon, TimerOffIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import type { LocalDecision } from '@dorks/client'
import { useDorksClient, useLocalAccess } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { usePending } from '../lib/pending'

// An agent's request to use the owner's own computer (docs/local-access.md), as a card in the chat. While it waits, the card shows
// exactly what would run (the command and its folder, or the file) and the agent's reason, labelled as the agent's words, with the
// owner's three answers. Afterwards it says what was decided, offers to stop a time-limited permission, and folds the output away.

type LocalBlock = Extract<Block, { kind: 'local' }>

/** The dork the transcript belongs to, so a card can answer for it. Without it (demos) the cards are read-only. */
const LocalAccessContext = createContext<{ dorkId: string; agent: string } | null>(null)

export function LocalAccessProvider({ dorkId, agent, children }: { dorkId: string; agent: string; children: ReactNode }) {
  return <LocalAccessContext.Provider value={{ dorkId, agent }}>{children}</LocalAccessContext.Provider>
}

const minutesText = (m?: number) => (m === 60 ? '1 hour' : m ? `${m} minutes` : 'a while')

function decidedText(block: LocalBlock): string {
  if (block.via === 'standing') return block.request === 'run' ? 'Allowed by the permission you gave earlier for this command.' : 'Allowed by the permission you gave earlier for this folder.'
  if (block.via === 'grant')
    return block.request === 'run' ? `You allowed this command in this folder for ${minutesText(block.minutes)}.` : `You allowed reading this folder for ${minutesText(block.minutes)}.`
  return 'You allowed it once.'
}

function title(block: LocalBlock, agent: string): string {
  const run = block.request === 'run'
  switch (block.status) {
    case 'pending':
      return run ? `${agent} wants to run a command on your computer` : `${agent} wants to read a file on your computer`
    case 'allowed':
      return run ? 'Running on your computer' : 'Reading on your computer'
    case 'done':
      return run ? `Ran on your computer${block.exitCode ? `, exit code ${block.exitCode}` : ''}` : 'Read a file on your computer'
    case 'failed':
      return run ? 'The command on your computer failed' : 'Could not read the file'
    case 'denied':
      return run ? 'You declined to run a command' : 'You declined to share a file'
    case 'expired':
      return 'Not answered in time'
  }
}

function icon(block: LocalBlock) {
  if (block.status === 'denied') return <ShieldXIcon />
  if (block.status === 'expired') return <TimerOffIcon />
  if (block.status === 'pending') return <LaptopIcon />
  return block.request === 'run' ? <TerminalIcon /> : <FileTextIcon />
}

/** The exact command and folder, or path: what the owner is agreeing to, verbatim. */
function Target({ block }: { block: LocalBlock }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-48">
          {block.request === 'run' ? block.command : block.path}
        </CodeBlockContent>
      </CodeBlock>
      {block.request === 'run' && block.cwd && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={block.cwd}>
          in {block.cwd}
        </p>
      )}
    </div>
  )
}

export function LocalRequestCard({ block }: { block: LocalBlock }) {
  const ctx = useContext(LocalAccessContext)
  const agent = ctx?.agent ?? 'The agent'
  const pending = block.status === 'pending'
  const line = (
    <TraceLine status={block.status === 'failed' ? 'error' : block.status === 'allowed' ? 'running' : undefined}>
      <TraceIcon>{icon(block)}</TraceIcon>
      <TraceTitle className={pending ? 'text-foreground' : undefined}>{title(block, agent)}</TraceTitle>
    </TraceLine>
  )
  return (
    <Trace role={pending ? 'alert' : 'status'} data-testid="local-request" data-status={block.status}>
      {line}
      <div className="flex min-w-0 flex-col gap-2 pl-6">
        <Target block={block} />
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{agent}’s reason:</span> {block.reason}
        </p>
        {pending ? <Answer block={block} /> : <Decided block={block} />}
        {!pending && block.preview && (
          <TraceCollapsible>
            <TraceCollapsibleTrigger className="text-xs">{block.request === 'run' ? 'Output' : 'Contents'}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <CodeBlock size="sm" variant={block.status === 'failed' ? 'destructive' : 'default'}>
                <CodeBlockContent wrap className="max-h-64">
                  {block.preview}
                </CodeBlockContent>
              </CodeBlock>
              {block.truncated && <p className="pt-1 text-xs">Only the end is shown here; {agent} got the whole result.</p>}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        )}
      </div>
    </Trace>
  )
}

function Answer({ block }: { block: LocalBlock }) {
  const ctx = useContext(LocalAccessContext)
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  if (!ctx) return null
  const answer = (d: LocalDecision) => void run(() => actions.decideLocal(ctx.dorkId, block.requestId, d))
  const run1 = block.request === 'run'
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => answer({ decision: 'once' })}>
          Allow once
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => answer({ decision: 'grant', minutes: 60 })}>
          {run1 ? 'Allow for 1 hour' : 'Allow this folder for 1 hour'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => answer({ decision: 'deny' })}>
          Deny
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {run1
          ? 'Runs in your login shell, as you, with no terminal. For 1 hour lets this session run this exact command in this folder again without asking.'
          : 'Shares this one text file. For 1 hour lets this session read other files in the same folder without asking.'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function Decided({ block }: { block: LocalBlock }) {
  const ctx = useContext(LocalAccessContext)
  if (block.status === 'denied' || block.status === 'expired') return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ShieldCheckIcon aria-hidden className="size-3.5" />
      <span>{decidedText(block)}</span>
      {ctx && block.grantId && <StopAllowing grantId={block.grantId} />}
    </div>
  )
}

/** Shown while the permission this card granted (or ran under) is still active. */
function StopAllowing({ grantId }: { grantId: string }) {
  const access = useLocalAccess()
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  if (!access?.grants.some((g) => g.id === grantId)) return null
  return (
    <Button size="xs" variant="outline" disabled={pending} onClick={() => void run(() => actions.revokeLocalGrant(grantId))}>
      Stop allowing
    </Button>
  )
}
