import { useMemo, useState, type ReactNode } from 'react'
import { BookOpenIcon, PlusIcon, SearchIcon, ServerIcon, XIcon } from 'lucide-react'
import type { McpServerView, SkillView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { toast } from 'sonner'
import { CONNECTORS, KINDS, type Connector } from '../connectors'
import { EmptyState } from '../EmptyState'
import { SettingsGroup, SettingsSection, SettingsSections, StatusDot } from '../settings/kit'
import { ConnectorIcon } from './PluginsDialogs'
import { SKILL_CATALOG, SKILL_GROUPS, type SkillCatalogEntry } from './skillsCatalog'

export type FilterScope = 'all' | 'installed'

const FILTER_BUTTON =
  'inline-flex h-7 cursor-pointer items-center rounded-[6px] px-2.5 text-xs font-normal text-muted-foreground transition-none outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[active=true]:bg-foreground/[0.07] data-[active=true]:text-foreground'

const ROW = 'flex min-h-13 w-full min-w-0 items-center gap-3 py-2.5 ps-4 pe-3 text-start hover:bg-foreground/[0.02]'
const ROW_MAIN =
  'flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[6px] text-start outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60'

/** Search input and All / Installed filter above the settings-kit sections. */
function SearchBar({
  query,
  onQueryChange,
  placeholder,
  scope,
  onScopeChange,
  countLabel,
  action,
}: {
  query: string
  onQueryChange: (q: string) => void
  placeholder: string
  scope: FilterScope
  onScopeChange: (s: FilterScope) => void
  countLabel: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="h-8 border-input bg-surface pr-7 pl-8 text-sm dark:border-border dark:bg-input/50"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
            className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Filter">
        <button type="button" data-active={scope === 'all' || undefined} onClick={() => onScopeChange('all')} className={FILTER_BUTTON}>
          All
        </button>
        <button type="button" data-active={scope === 'installed' || undefined} onClick={() => onScopeChange('installed')} className={FILTER_BUTTON}>
          Installed
        </button>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">{countLabel}</span>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Plugins directory

export function PluginsDirectory({
  servers,
  customServers,
  isConnected,
  composioLoading,
  onAddCustom,
  onOpenConnector,
  onEditServer,
  onInspectInstalled,
}: {
  servers: McpServerView[] | undefined
  customServers: McpServerView[]
  isConnected: (c: Connector) => boolean
  composioLoading: boolean
  onAddCustom: () => void
  onOpenConnector: (c: Connector) => void
  onEditServer: (s: McpServerView) => void
  onInspectInstalled: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<FilterScope>('all')
  const q = query.trim().toLowerCase()

  const groups = useMemo(() => {
    const out: { id: string; title: string; items: ({ kind: 'connector'; c: Connector; connected: boolean } | { kind: 'server'; s: McpServerView })[] }[] = []

    const matchingCustom = customServers.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.url ?? s.command ?? '').toLowerCase().includes(q))
    if (matchingCustom.length > 0) {
      out.push({
        id: 'custom',
        title: 'Custom',
        items: matchingCustom.map((s) => ({ kind: 'server', s })),
      })
    }

    for (const k of KINDS) {
      const items = CONNECTORS.filter((c) => c.kind === k.id)
        .map((c) => ({ kind: 'connector' as const, c, connected: isConnected(c) }))
        .filter(({ c, connected }) => {
          if (scope === 'installed' && !connected) return false
          if (!q) return true
          return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.by.toLowerCase().includes(q) || k.title.toLowerCase().includes(q)
        })
      if (items.length > 0) out.push({ id: k.id, title: k.title, items })
    }
    return out
  }, [customServers, isConnected, q, scope])

  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-5 pb-16 sm:px-6">
        <SearchBar
          query={query}
          onQueryChange={setQuery}
          placeholder="Search plugins…"
          scope={scope}
          onScopeChange={setScope}
          countLabel={`${total} ${total === 1 ? 'plugin' : 'plugins'}`}
          action={
            <Button size="sm" onClick={onAddCustom}>
              <PlusIcon data-icon="inline-start" />
              Add custom
            </Button>
          }
        />

        {total === 0 ? (
          <div className="flex min-h-56 items-center justify-center py-8">
            <EmptyState
              figure="drawer"
              title={q ? 'No matching plugins' : 'No installed plugins yet'}
              description={q ? 'Try another name or category.' : 'Install a plugin from the directory to give every session access to its tools.'}
            >
              {q ? (
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setScope('all')}>
                  Browse all plugins
                </Button>
              )}
            </EmptyState>
          </div>
        ) : (
          <SettingsSections>
            {groups.map((g) => (
              <SettingsSection key={g.id} title={g.title} actions={<span className="text-xs text-muted-foreground tabular-nums">{g.items.length}</span>}>
                <SettingsGroup label={g.title}>
                  {g.items.map((item) => {
                    if (item.kind === 'server') {
                      const s = item.s
                      const where = s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')
                      return (
                        <div key={`server:${s.name}`} className={ROW}>
                          <button type="button" onClick={() => onInspectInstalled(`server:${s.name}`)} className={ROW_MAIN}>
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                              <ServerIcon className="size-3.5" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="truncate font-mono text-xs leading-4 text-foreground">{s.name}</span>
                              <span className="truncate font-mono text-xs leading-4 text-muted-foreground">{where}</span>
                            </span>
                          </button>
                          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{s.transport === 'http' ? 'HTTP' : 'Local'}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <StatusDot tone="success" />
                            <span className="hidden sm:inline">Installed</span>
                          </span>
                          <Button type="button" variant="ghost" size="sm" onClick={() => onInspectInstalled(`server:${s.name}`)}>
                            Manage
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => onEditServer(s)}>
                            Edit
                          </Button>
                        </div>
                      )
                    }

                    const { c, connected } = item
                    const loading = !servers || (!!c.toolkit && composioLoading)
                    return (
                      <div key={c.id} className={ROW}>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            if (connected) onInspectInstalled(`connector:${c.id}`)
                            else onOpenConnector(c)
                          }}
                          className={ROW_MAIN}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04]">
                            <ConnectorIcon connector={c} className="size-4" />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-sm leading-4 text-foreground">{c.name}</span>
                            <span className="truncate text-xs leading-4 text-muted-foreground">{c.description}</span>
                          </span>
                        </button>
                        <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{c.toolkit ? 'OAuth' : 'API key'}</span>
                        {connected ? (
                          <>
                            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <StatusDot tone="success" />
                              <span className="hidden sm:inline">Installed</span>
                            </span>
                            <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => onOpenConnector(c)}>
                              Manage
                            </Button>
                          </>
                        ) : (
                          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => onOpenConnector(c)}>
                            Install
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </SettingsGroup>
              </SettingsSection>
            ))}
          </SettingsSections>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Skills directory

export function SkillsDirectory({ skills, onAddSkill, onInspectInstalled }: { skills: SkillView[] | undefined; onAddSkill: (source?: string) => void; onInspectInstalled: (key: string) => void }) {
  const { actions } = useDorksClient()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<FilterScope>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const q = query.trim().toLowerCase()

  const installedByName = useMemo(() => new Map((skills ?? []).map((s) => [s.name, s])), [skills])

  const installQuick = async (entry: SkillCatalogEntry) => {
    setBusy(entry.name)
    try {
      await actions.installSkills(entry.source, [entry.name])
      toast.success(`Installed ${entry.name}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : `Could not install ${entry.name}`)
    } finally {
      setBusy(null)
    }
  }

  const groups = useMemo(() => {
    const out: {
      id: string
      title: string
      items: { name: string; description: string; source: string; installed?: SkillView; catalog?: SkillCatalogEntry }[]
    }[] = []

    const catalogNames = new Set(SKILL_CATALOG.map((c) => c.name))
    const customInstalled = (skills ?? [])
      .filter((s) => !catalogNames.has(s.name))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.source.repo.toLowerCase().includes(q))

    if (customInstalled.length > 0) {
      out.push({
        id: 'custom',
        title: 'Custom',
        items: customInstalled.map((s) => ({
          name: s.name,
          description: s.description || 'Installed from GitHub',
          source: s.source.repo,
          installed: s,
        })),
      })
    }

    for (const g of SKILL_GROUPS) {
      const items = SKILL_CATALOG.filter((c) => c.group === g.id)
        .map((c) => ({
          name: c.name,
          description: installedByName.get(c.name)?.description || c.description,
          source: installedByName.get(c.name)?.source.repo ?? c.source,
          installed: installedByName.get(c.name),
          catalog: c,
        }))
        .filter((item) => {
          if (scope === 'installed' && !item.installed) return false
          if (!q) return true
          return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q) || item.source.toLowerCase().includes(q) || g.title.toLowerCase().includes(q)
        })
      if (items.length > 0) out.push({ id: g.id, title: g.title, items })
    }

    return out
  }, [installedByName, q, scope, skills])

  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-5 pb-16 sm:px-6">
        <SearchBar
          query={query}
          onQueryChange={setQuery}
          placeholder="Search skills…"
          scope={scope}
          onScopeChange={setScope}
          countLabel={`${total} ${total === 1 ? 'skill' : 'skills'}`}
          action={
            <Button size="sm" onClick={() => onAddSkill()}>
              <PlusIcon data-icon="inline-start" />
              Add skill
            </Button>
          }
        />

        {total === 0 ? (
          <div className="flex min-h-56 items-center justify-center py-8">
            <EmptyState
              figure="drawer"
              title={q ? 'No matching skills' : 'No installed skills yet'}
              description={q ? 'Try another keyword or add any skill from GitHub.' : 'Skills you install reach every session in each sandbox.'}
            >
              {q ? (
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => onAddSkill()}>
                  Add skill
                </Button>
              )}
            </EmptyState>
          </div>
        ) : (
          <SettingsSections>
            {groups.map((g) => (
              <SettingsSection key={g.id} title={g.title} actions={<span className="text-xs text-muted-foreground tabular-nums">{g.items.length}</span>}>
                <SettingsGroup label={g.title}>
                  {g.items.map((item) => {
                    const isBusy = busy === item.name
                    return (
                      <div key={item.name} className={ROW}>
                        <button
                          type="button"
                          onClick={() => {
                            if (item.installed) onInspectInstalled(`skill:${item.name}`)
                            else if (item.catalog) onAddSkill(item.catalog.source)
                          }}
                          className={ROW_MAIN}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                            <BookOpenIcon className="size-3.5" />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate font-mono text-xs leading-4 text-foreground">{item.name}</span>
                            <span className="truncate text-xs leading-4 text-muted-foreground">{item.description}</span>
                          </span>
                        </button>
                        <span className="hidden shrink-0 font-mono text-xs text-muted-foreground lg:inline">{item.source}</span>
                        {item.installed ? (
                          <>
                            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <StatusDot tone="success" />
                              <span className="hidden sm:inline">Installed</span>
                            </span>
                            <Button type="button" variant="ghost" size="sm" onClick={() => onInspectInstalled(`skill:${item.name}`)}>
                              Manage
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => {
                              if (item.catalog) void installQuick(item.catalog)
                              else onAddSkill()
                            }}
                          >
                            {isBusy ? 'Installing…' : 'Install'}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </SettingsGroup>
              </SettingsSection>
            ))}
          </SettingsSections>
        )}
      </div>
    </div>
  )
}
