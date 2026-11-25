import { useMemo, useState, type ReactNode } from 'react'
import { BookOpenIcon, ChevronRightIcon, SearchIcon, ServerIcon, XIcon } from 'lucide-react'
import type { McpServerView, SkillView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { cn } from 'cn'
import { toast } from 'sonner'
import { CONNECTORS, KINDS, type Connector } from '../connectors'
import { EmptyState } from '../EmptyState'
import { StatusDot } from '../settings/kit'
import { ConnectorIcon } from './PluginsDialogs'
import { SKILL_CATALOG, SKILL_GROUPS, type SkillCatalogEntry } from './skillsCatalog'

export type FilterScope = 'all' | 'installed'

const FILTER_BUTTON =
  'inline-flex h-7 cursor-pointer items-center rounded-[6px] px-2.5 text-xs font-normal text-muted-foreground transition-none outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[active=true]:bg-foreground/[0.07] data-[active=true]:text-foreground'

/** Full-width 40px search and filter toolbar sitting right below the 48px header. */
function SearchToolbar({
  query,
  onQueryChange,
  placeholder,
  scope,
  onScopeChange,
  countLabel,
}: {
  query: string
  onQueryChange: (q: string) => void
  placeholder: string
  scope: FilterScope
  onScopeChange: (s: FilterScope) => void
  countLabel: string
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-5">
      <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQueryChange('')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Filter">
        <button type="button" data-active={scope === 'all' || undefined} onClick={() => onScopeChange('all')} className={FILTER_BUTTON}>
          All
        </button>
        <button type="button" data-active={scope === 'installed' || undefined} onClick={() => onScopeChange('installed')} className={FILTER_BUTTON}>
          Installed
        </button>
      </div>
      <span className="hidden shrink-0 pl-1 text-xs text-muted-foreground tabular-nums sm:inline">{countLabel}</span>
    </div>
  )
}

/** Collapsible group section inside the flat hairline table. */
function TableGroup({ title, count, collapsed, onToggle, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 border-b border-border bg-foreground/[0.02] px-5 text-left outline-none hover:bg-foreground/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRightIcon aria-hidden className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', !collapsed && 'rotate-90')} />
        <span className="text-xs font-medium text-foreground/80">{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      </button>
      {!collapsed && <div role="rowgroup">{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------- Plugins directory table

const PLUGINS_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[minmax(180px,220px)_minmax(0,1fr)_92px_136px]'

export function PluginsDirectory({
  servers,
  customServers,
  isConnected,
  composioLoading,
  onOpenConnector,
  onEditServer,
  onInspectInstalled,
}: {
  servers: McpServerView[] | undefined
  customServers: McpServerView[]
  isConnected: (c: Connector) => boolean
  composioLoading: boolean
  onOpenConnector: (c: Connector) => void
  onEditServer: (s: McpServerView) => void
  onInspectInstalled: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<FilterScope>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const q = query.trim().toLowerCase()

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SearchToolbar query={query} onQueryChange={setQuery} placeholder="Search plugins…" scope={scope} onScopeChange={setScope} countLabel={`${total} ${total === 1 ? 'plugin' : 'plugins'}`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total === 0 ? (
          <div className="flex min-h-64 items-center justify-center px-5 py-12">
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
          <div role="table" aria-label="Plugins">
            <div role="row" className={`sticky top-0 z-10 h-8 border-b border-border bg-background px-5 text-xs text-muted-foreground ${PLUGINS_GRID}`}>
              <div role="columnheader">Plugin</div>
              <div role="columnheader" className="hidden md:block">
                Description
              </div>
              <div role="columnheader" className="hidden md:block">
                Auth
              </div>
              <div role="columnheader" className="text-right">
                Status
              </div>
            </div>
            {groups.map((g) => (
              <TableGroup key={g.id} title={g.title} count={g.items.length} collapsed={collapsed.has(g.id)} onToggle={() => toggleGroup(g.id)}>
                {g.items.map((item) => {
                  if (item.kind === 'server') {
                    const s = item.s
                    const where = s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')
                    return (
                      <div
                        key={`server:${s.name}`}
                        role="row"
                        onClick={() => onInspectInstalled(`server:${s.name}`)}
                        className={`min-h-12 cursor-pointer border-b border-border px-5 py-2.5 hover:bg-foreground/[0.02] ${PLUGINS_GRID}`}
                      >
                        <div role="cell" className="flex min-w-0 items-center gap-3">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                            <ServerIcon className="size-3.5" />
                          </span>
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate font-mono text-xs text-foreground">{s.name}</span>
                            <span className="truncate font-mono text-xs text-muted-foreground md:hidden">{where}</span>
                          </div>
                        </div>
                        <div role="cell" className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block">
                          {where}
                        </div>
                        <div role="cell" className="hidden text-xs text-muted-foreground md:block">
                          {s.transport === 'http' ? 'HTTP' : 'Local'}
                        </div>
                        <div role="cell" className="flex items-center justify-end gap-2">
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <StatusDot tone="success" />
                            <span className="hidden sm:inline">Installed</span>
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditServer(s)
                            }}
                          >
                            Edit
                          </Button>
                        </div>
                      </div>
                    )
                  }

                  const { c, connected } = item
                  const loading = !servers || (!!c.toolkit && composioLoading)
                  return (
                    <div
                      key={c.id}
                      role="row"
                      onClick={() => {
                        if (loading) return
                        if (connected) onInspectInstalled(`connector:${c.id}`)
                        else onOpenConnector(c)
                      }}
                      className={`min-h-12 cursor-pointer border-b border-border px-5 py-2.5 hover:bg-foreground/[0.02] ${PLUGINS_GRID}`}
                    >
                      <div role="cell" className="flex min-w-0 items-center gap-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04]">
                          <ConnectorIcon connector={c} className="size-4" />
                        </span>
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm text-foreground">{c.name}</span>
                          <span className="truncate text-xs text-muted-foreground md:hidden">{c.description}</span>
                        </div>
                      </div>
                      <div role="cell" className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
                        {c.description}
                      </div>
                      <div role="cell" className="hidden text-xs text-muted-foreground md:block">
                        {c.toolkit ? 'OAuth' : 'API key'}
                      </div>
                      <div role="cell" className="flex items-center justify-end gap-2">
                        {connected ? (
                          <>
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <StatusDot tone="success" />
                              <span className="hidden sm:inline">Installed</span>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={loading}
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenConnector(c)
                              }}
                            >
                              Manage
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={loading}
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpenConnector(c)
                            }}
                          >
                            Install
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </TableGroup>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Skills directory table

const SKILLS_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[minmax(190px,240px)_minmax(0,1fr)_170px_136px]'

export function SkillsDirectory({ skills, onAddSkill, onInspectInstalled }: { skills: SkillView[] | undefined; onAddSkill: (source?: string) => void; onInspectInstalled: (key: string) => void }) {
  const { actions } = useDorksClient()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<FilterScope>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const q = query.trim().toLowerCase()

  const installedByName = useMemo(() => new Map((skills ?? []).map((s) => [s.name, s])), [skills])

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SearchToolbar query={query} onQueryChange={setQuery} placeholder="Search skills…" scope={scope} onScopeChange={setScope} countLabel={`${total} ${total === 1 ? 'skill' : 'skills'}`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total === 0 ? (
          <div className="flex min-h-64 items-center justify-center px-5 py-12">
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
          <div role="table" aria-label="Skills">
            <div role="row" className={`sticky top-0 z-10 h-8 border-b border-border bg-background px-5 text-xs text-muted-foreground ${SKILLS_GRID}`}>
              <div role="columnheader">Skill</div>
              <div role="columnheader" className="hidden md:block">
                Description
              </div>
              <div role="columnheader" className="hidden md:block">
                Source
              </div>
              <div role="columnheader" className="text-right">
                Status
              </div>
            </div>
            {groups.map((g) => (
              <TableGroup key={g.id} title={g.title} count={g.items.length} collapsed={collapsed.has(g.id)} onToggle={() => toggleGroup(g.id)}>
                {g.items.map((item) => {
                  const isBusy = busy === item.name
                  return (
                    <div
                      key={item.name}
                      role="row"
                      onClick={() => {
                        if (item.installed) onInspectInstalled(`skill:${item.name}`)
                        else if (item.catalog) onAddSkill(item.catalog.source)
                      }}
                      className={`min-h-12 cursor-pointer border-b border-border px-5 py-2.5 hover:bg-foreground/[0.02] ${SKILLS_GRID}`}
                    >
                      <div role="cell" className="flex min-w-0 items-center gap-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                          <BookOpenIcon className="size-3.5" />
                        </span>
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-mono text-xs text-foreground">{item.name}</span>
                          <span className="truncate text-xs text-muted-foreground md:hidden">{item.description}</span>
                        </div>
                      </div>
                      <div role="cell" className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
                        {item.description}
                      </div>
                      <div role="cell" className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block">
                        {item.source}
                      </div>
                      <div role="cell" className="flex items-center justify-end gap-2">
                        {item.installed ? (
                          <>
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <StatusDot tone="success" />
                              <span className="hidden sm:inline">Installed</span>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                onInspectInstalled(`skill:${item.name}`)
                              }}
                            >
                              Manage
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (item.catalog) void installQuick(item.catalog)
                              else onAddSkill()
                            }}
                          >
                            {isBusy ? 'Installing…' : 'Install'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </TableGroup>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
