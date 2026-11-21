import { Link } from '@tanstack/react-router'
import { SparklesIcon } from 'lucide-react'
import type { BuildView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { SettingsGroup, SettingsSection } from '../settings/kit'
import { ago, firstLine } from './format'
import { ROW, RowText } from './shared'

export function AgentChanges({ build }: { build: BuildView }) {
  const drafts = [...build.drafts.filter((d) => d.status === 'submitted'), ...build.drafts.filter((d) => d.status === 'editing')]
  if (drafts.length === 0) return null
  return (
    <SettingsSection title="Agent changes">
      <SettingsGroup label="agent drafts">
        {drafts.map((d) => (
          <div key={d.id} className={ROW}>
            <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />
            <RowText
              title={d.status === 'submitted' ? 'Change to review' : 'Change in progress'}
              description={`${d.note ? `${firstLine(d.note)} · ` : ''}from ${d.dorkTitle || 'a session'} · ${ago(d.updatedAt)}`}
            />
            <Button size="sm" variant={d.status === 'submitted' ? 'outline' : 'ghost'} nativeButton={false} render={<Link to="/builds" search={{ build: build.id, review: d.id }} />}>
              {d.status === 'submitted' ? 'Review' : 'View'}
            </Button>
          </div>
        ))}
      </SettingsGroup>
    </SettingsSection>
  )
}
