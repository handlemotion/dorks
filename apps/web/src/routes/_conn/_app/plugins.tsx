import { useCallback, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRightIcon } from 'lucide-react'
import { useComposio, useMcpServers, useSkills } from '@dorks/client/react'
import { useSidebar } from '@dorks/ui/sidebar'
import { CONNECTORS, type Connector } from '../../../components/connectors'
import { InstalledDetail } from '../../../components/plugins/InstalledDetail'
import { AppDialog, BLANK_DRAFT, ConnectDialog, draftOf, isComposio, isPreset, ServerDialog, type Draft } from '../../../components/plugins/PluginsDialogs'
import { PluginsNav, type InstalledItem, type PluginsTab } from '../../../components/plugins/PluginsNav'
import { PluginsDirectory, SkillsDirectory } from '../../../components/plugins/PluginsTable'
import { TAB_CLASS } from '../../../components/PullRequestPanel'
import { AddSkillDialog } from '../../../components/SkillsTab'
import { TITLEBAR_CONTROLS_END } from '../../../components/WindowControls'

type Search = { tab?: PluginsTab; selected?: string }

export const Route = createFileRoute('/_conn/_app/plugins')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.tab === 'plugins' || s.tab === 'skills' ? { tab: s.tab } : {}),
    ...(typeof s.selected === 'string' && s.selected ? { selected: s.selected } : {}),
  }),
  component: PluginsPage,
})

function itemTitle(item: InstalledItem) {
  if (item.kind === 'connector') return item.connector.name
  if (item.kind === 'server') return item.server.name
  return item.skill.name
}

/** Shown only on narrow screens (where PluginsNav is hidden) or as a breadcrumb header for an installed item. */
function MobileHeader({ tab, selectedItem, onSelectTab }: { tab: PluginsTab; selectedItem?: InstalledItem; onSelectTab: (tab: PluginsTab) => void }) {
  const { isMobile } = useSidebar()
  const title = selectedItem ? itemTitle(selectedItem) : tab === 'skills' ? 'Skills' : 'Plugins'
  const parent = selectedItem ? (selectedItem.kind === 'skill' ? 'Skills' : 'Plugins') : undefined

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-3 pl-5 md:hidden"
      style={isMobile ? { paddingLeft: TITLEBAR_CONTROLS_END } : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {parent && (
            <>
              <button type="button" onClick={() => onSelectTab(parent === 'Skills' ? 'skills' : 'plugins')} className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground">
                {parent}
              </button>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
          <h1 className="truncate text-sm font-normal!">{title}</h1>
        </div>

        <div className="ms-1 flex items-center gap-0.5" role="tablist" aria-label="Plugins sections">
          <button
            type="button"
            role="tab"
            aria-selected={!selectedItem && tab === 'plugins'}
            data-active={!selectedItem && tab === 'plugins' ? 'true' : undefined}
            onClick={() => onSelectTab('plugins')}
            className={TAB_CLASS}
          >
            Plugins
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!selectedItem && tab === 'skills'}
            data-active={!selectedItem && tab === 'skills' ? 'true' : undefined}
            onClick={() => onSelectTab('skills')}
            className={TAB_CLASS}
          >
            Skills
          </button>
        </div>
      </div>
    </header>
  )
}

function PluginsPage() {
  const servers = useMcpServers()
  const composio = useComposio()
  const skills = useSkills()
  const search = Route.useSearch()
  const tab: PluginsTab = search.tab ?? 'plugins'
  const navigate = useNavigate({ from: Route.fullPath })

  const [draft, setDraft] = useState<Draft | null>(null)
  const [connecting, setConnecting] = useState<Connector | null>(null)
  const [addingSkill, setAddingSkill] = useState<{ source?: string } | null>(null)

  const customServers = useMemo(() => servers?.filter((s) => !isPreset(s) && !isComposio(s)) ?? [], [servers])
  const isConnected = useCallback((c: Connector) => (c.toolkit ? !!composio?.toolkits.includes(c.toolkit) : !!servers?.some((s) => s.name === c.id && isPreset(s))), [composio, servers])

  const openConnector = (c: Connector) => {
    const taken = !c.toolkit && servers?.find((s) => s.name === c.id && !isPreset(s))
    if (taken) setDraft(draftOf(taken))
    else setConnecting(c)
  }

  const installed = useMemo<InstalledItem[]>(() => {
    const connectors: InstalledItem[] = CONNECTORS.filter(isConnected).map((connector) => ({ kind: 'connector', key: `connector:${connector.id}`, connector }))
    const custom: InstalledItem[] = customServers.map((server) => ({ kind: 'server', key: `server:${server.name}`, server }))
    const installedSkills: InstalledItem[] = (skills ?? []).map((skill) => ({ kind: 'skill', key: `skill:${skill.name}`, skill }))
    return [...connectors, ...custom, ...installedSkills]
  }, [customServers, isConnected, skills])

  const selectedItem = search.selected ? installed.find((i) => i.key === search.selected) : undefined
  const selectTab = (next: PluginsTab) => void navigate({ search: { tab: next }, replace: true })
  const selectInstalled = (key: string) => void navigate({ search: { tab: key.startsWith('skill:') ? 'skills' : 'plugins', selected: key }, replace: true })

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <PluginsNav tab={tab} selected={selectedItem?.key} installed={installed} onSelectTab={selectTab} onSelectInstalled={selectInstalled} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MobileHeader tab={tab} selectedItem={selectedItem} onSelectTab={selectTab} />

        {selectedItem ? (
          <InstalledDetail
            item={selectedItem}
            onManageConnector={() => selectedItem.kind === 'connector' && openConnector(selectedItem.connector)}
            onEditServer={() => selectedItem.kind === 'server' && setDraft(draftOf(selectedItem.server))}
            onRemoved={() => selectTab(selectedItem.kind === 'skill' ? 'skills' : 'plugins')}
          />
        ) : tab === 'skills' ? (
          <SkillsDirectory skills={skills} onAddSkill={(source) => setAddingSkill({ source })} onInspectInstalled={selectInstalled} />
        ) : (
          <PluginsDirectory
            servers={servers}
            customServers={customServers}
            isConnected={isConnected}
            composioLoading={!composio}
            onAddCustom={() => setDraft(BLANK_DRAFT)}
            onOpenConnector={openConnector}
            onEditServer={(s) => setDraft(draftOf(s))}
            onInspectInstalled={selectInstalled}
          />
        )}
      </div>

      {addingSkill && <AddSkillDialog key={addingSkill.source ?? ''} initial={addingSkill.source} onClose={() => setAddingSkill(null)} />}
      {draft && <ServerDialog key={`${draft.name}:${draft.editing}`} initial={draft} onClose={() => setDraft(null)} />}
      {connecting &&
        (connecting.toolkit !== undefined ? (
          <AppDialog
            key={connecting.id}
            app={connecting}
            keySaved={!!composio?.connected}
            instant={composio?.personal ? composio.instant : undefined}
            statusError={composio?.error}
            connected={isConnected(connecting)}
            onClose={() => setConnecting(null)}
          />
        ) : (
          <ConnectDialog key={connecting.id} connector={connecting} connected={isConnected(connecting)} onClose={() => setConnecting(null)} />
        ))}
    </div>
  )
}
