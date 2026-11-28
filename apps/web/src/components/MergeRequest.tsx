import { useContext } from 'react'
import { CircleSlashIcon, GitMergeIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { usePending } from '../lib/pending'
import { LocalAccessContext } from './LocalRequest'

// The agent asks the owner to merge one of its PRs (docs/autonomy.md, "Asking to merge"). While it waits, a compact card: the PR, the
// agent's note, Merge / Not now. Merge merges the commit the agent asked about, so a later push is never merged unseen. Once answered,
// one line in the thread.

type MergeBlock = Extract<Block, { kind: 'merge' }>

const label = (b: MergeBlock) => `${b.repo}#${b.number}`

export function MergeRequestCard({ block }: { block: MergeBlock }) {
  if (block.status === 'pending') return <MergePrompt block={block} />
  const title =
    block.status === 'merged'
      ? `Merged ${label(block)}`
      : block.status === 'queued'
        ? `Handed ${label(block)} to GitHub to merge`
        : block.status === 'declined'
          ? `You chose not to merge ${label(block)}`
          : block.status === 'replaced'
            ? `Asked again to merge ${label(block)} at a newer commit`
            : `Could not merge ${label(block)}${block.reason ? `: ${block.reason}` : ''}`
  const icon = block.status === 'declined' ? <CircleSlashIcon /> : block.status === 'failed' ? <TriangleAlertIcon /> : block.status === 'replaced' ? <RefreshCwIcon /> : <GitMergeIcon />
  return (
    <Trace data-testid="merge-request" data-status={block.status} className="my-1.5">
      <TraceLine role="status" status={block.status === 'failed' ? 'error' : undefined} className="text-(length:--text-message)" title={block.title}>
        <TraceIcon>{icon}</TraceIcon>
        <TraceTitle>{title}</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

function MergePrompt({ block }: { block: MergeBlock }) {
  const ctx = useContext(LocalAccessContext)
  const agent = ctx?.agent ?? 'The agent'
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const answer = (merge: boolean) => ctx && void run(() => actions.decideMerge(ctx.dorkId, block.requestId, { merge }))
  // The same raised block as the computer-access card: the surface fill with its hairline, one padded block.
  return (
    <div role="alert" data-testid="merge-request" data-status="pending" className="flex w-full min-w-0 flex-col gap-3 rounded-[6px] border border-surface-line bg-surface px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2.5 text-sm text-foreground">
          <GitMergeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {agent} wants to merge{' '}
            <a href={block.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {label(block)}
            </a>
          </span>
        </p>
        <p className="truncate pl-6.5 text-sm text-foreground" title={block.title}>
          {block.title}
        </p>
        {block.note && <p className="pl-6.5 text-sm text-muted-foreground">{block.note}</p>}
        <p className="pl-6.5 font-mono text-xs text-muted-foreground">At {block.sha.slice(0, 7)}</p>
      </div>
      {ctx && (
        <div className="flex flex-wrap gap-2 pl-6.5">
          <Button size="sm" disabled={pending} onClick={() => answer(true)}>
            Merge
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => answer(false)}>
            Not now
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
