import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { KeyRoundIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildView } from '@dorks/client'
import { useBuilds, useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { EmptyState } from '../EmptyState'
import { PageRail, RailPage } from '../PageRail'
import { SettingsGroup, SettingsSection, SettingsSections } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { sizeOf, ago, status, TONE_TEXT, firstLine } from './format'
import { Dot, ROW, LINK_ROW, Chevron, RowText } from './shared'
import { SetupDialog } from './SetupDialog'

/** A build matches a search by its name or one of its repositories. */
const matches = (b: BuildView, q: string) => !q || b.name.toLowerCase().includes(q) || b.repos.some((r) => r.repo.toLowerCase().includes(q))

export function BuildList() {
  const builds = useBuilds()
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending } = usePending()
  const [settingUp, setSettingUp] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const create = () =>
    run(async () => {
      const taken = new Set(builds?.map((b) => b.name.toLowerCase()))
      let name = 'New build'
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New build ${n}`
      const { id } = await actions.createBuild({ name })
      await navigate({ to: '/builds', search: { build: id } })
    })
  const newButton = (
    <Button size="sm" variant={builds?.length ? 'default' : 'outline'} disabled={pending} onClick={() => void create()}>
      <PlusIcon data-icon="inline-start" />
      New build
    </Button>
  )
  if (builds && builds.length === 0)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <RailPage title="Builds">
          <EmptyState figure="stack" title="No builds yet" description="A build is a machine set up once: tools installed, variables set, repositories cloned.">
            {newButton}
          </EmptyState>
        </RailPage>
      </div>
    )
  const reviews = builds?.flatMap((b) => b.drafts.filter((d) => d.status === 'submitted').map((d) => ({ b, d }))) ?? []
  const requested = builds?.flatMap((b) => b.vars.filter((v) => v.requested).map((v) => ({ b, v }))) ?? []
  const fallback = builds?.find((b) => b.isDefault)
  const shown = builds?.filter((b) => matches(b, q))
  return (
    <div className="flex h-full min-h-0 flex-col">
      {fallback && <SetupDialog build={fallback} open={settingUp} onOpenChange={setSettingUp} />}
      <RailPage title="Builds">
        <PageRail
          query={query}
          onQueryChange={setQuery}
          placeholder="Search builds…"
          actions={
            <>
              {fallback && (
                <Button size="sm" variant="ghost" onClick={() => setSettingUp(true)}>
                  Set up with an agent
                </Button>
              )}
              {newButton}
            </>
          }
        />
        <SettingsSections>
          {(reviews.length > 0 || requested.length > 0) && (
            <SettingsSection title="Needs you">
              <SettingsGroup label="needs you">
                {reviews.map(({ b, d }) => (
                  <div key={d.id} className={ROW}>
                    <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />
                    <RowText title={`An agent proposed changes to ${b.name}`} description={`${d.note ? `${firstLine(d.note)} · ` : ''}from ${d.dorkTitle || 'a session'} · ${ago(d.updatedAt)}`} />
                    <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: b.id, review: d.id }} />}>
                      Review
                    </Button>
                  </div>
                ))}
                {requested.map(({ b, v }) => (
                  <div key={`${b.id}:${v.name}`} className={ROW}>
                    <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                    <RowText
                      title={
                        <>
                          <code className="font-mono text-xs">{v.name}</code> is waiting for a value
                        </>
                      }
                      description={`${b.name} needs it${v.buildTime ? ' while building' : ''}`}
                    />
                    <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: b.id }} />}>
                      Fill in
                    </Button>
                  </div>
                ))}
              </SettingsGroup>
            </SettingsSection>
          )}
          <BuildRows builds={shown} query={q} titled={reviews.length > 0 || requested.length > 0} onClear={() => setQuery('')} />
        </SettingsSections>
      </RailPage>
    </div>
  )
}

/** The builds a search left, or a way back when it left none. */
function BuildRows({ builds, query, titled, onClear }: { builds?: BuildView[]; query: string; titled: boolean; onClear: () => void }) {
  const group = (
    <SettingsGroup label="builds">
      {builds?.map((b) => {
        const s = status(b)
        return (
          <Link key={b.id} to="/builds" search={{ build: b.id }} className={LINK_ROW}>
            <Dot tone={s.tone} />
            <RowText
              title={
                <>
                  {b.name}
                  {b.isDefault && <span className="ms-2 text-xs text-muted-foreground">Default</span>}
                </>
              }
              description={b.repos.length ? <span className="font-mono">{b.repos.map((r) => r.repo).join(' · ')}</span> : 'No repositories'}
            />
            <span className="hidden w-32 shrink-0 text-xs text-muted-foreground md:block">{sizeOf(b.machineType).short}</span>
            <span className={cn('w-44 shrink-0 truncate text-end text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
            <Chevron />
          </Link>
        )
      })}
    </SettingsGroup>
  )
  return (
    <>
      {!!builds?.length && (titled ? <SettingsSection title="Builds">{group}</SettingsSection> : group)}
      {query && !builds?.length && (
        <EmptyState figure="stack" title="No matching builds" description="Try another name or repository.">
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear search
          </Button>
        </EmptyState>
      )}
    </>
  )
}
