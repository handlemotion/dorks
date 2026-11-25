import { Link } from '@tanstack/react-router'
import { SparklesIcon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { ago, firstLine } from './format'
import { ROW, RowText } from './shared'

/**
 * Agents' changes to the build, first on its page: a change waiting for the owner is a brand-tinted row with a primary Review button,
 * one still being written a quiet row under it.
 */
export function AgentChanges({ build }: { build: BuildView }) {
  const drafts = [...build.drafts.filter((d) => d.status === 'submitted'), ...build.drafts.filter((d) => d.status === 'editing')]
  if (drafts.length === 0) return null
  return (
    <section aria-label="Agent changes" className="flex flex-col gap-2">
      {drafts.map((d) => {
        const waiting = d.status === 'submitted'
        const who = d.dorkTitle || 'An agent'
        return (
          <div key={d.id} className={cn(ROW, 'rounded-[6px]', waiting ? 'bg-brand/[0.08] dark:bg-brand/[0.16]' : 'bg-foreground/[0.03]')}>
            <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />
            <RowText title={waiting ? `${who} proposed a change` : `${who} is drafting a change`} description={`${d.note ? `${firstLine(d.note)} · ` : ''}${ago(d.updatedAt)}`} />
            <Button size="sm" variant={waiting ? 'default' : 'ghost'} nativeButton={false} render={<Link to="/builds" search={{ build: build.id, review: d.id }} />}>
              {waiting ? 'Review' : 'View'}
            </Button>
          </div>
        )
      })}
    </section>
  )
}
