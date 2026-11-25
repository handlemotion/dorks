import { BlocksIcon, BookOpenIcon, ServerIcon } from 'lucide-react'
import type { McpServerView, SkillView } from '@dorks/client'
import { FluidHoverHighlight } from '@dorks/ui/fluid-hover-highlight'
import { useSidebar } from '@dorks/ui/sidebar'
import type { Connector } from '../connectors'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from '../sidebarChrome'
import { useRowHover } from '../useRowHover'
import { TITLEBAR_CONTROLS_END } from '../WindowControls'
import { ConnectorIcon } from './PluginsDialogs'

export type PluginsTab = 'plugins' | 'skills'

export type InstalledPlugin = { kind: 'connector'; key: string; connector: Connector } | { kind: 'server'; key: string; server: McpServerView }

export type SelectedItem = InstalledPlugin | { kind: 'skill'; key: string; skill: SkillView }

/**
 * The second navbar column inside the Plugins page: close to the main sidebar's width (280px vs 300px), with no divider under its
 * title bar, top tab links for Plugins and Skills, and an Installed group listing active plugins (connectors and custom MCP servers).
 */
export function PluginsNav({
  tab,
  selected,
  installed,
  onSelectTab,
  onSelectInstalled,
}: {
  tab: PluginsTab
  selected?: string
  installed: InstalledPlugin[]
  onSelectTab: (tab: PluginsTab) => void
  onSelectInstalled: (key: string) => void
}) {
  const { open, isMobile } = useSidebar()
  const hover = useRowHover()
  const skillsActive = tab === 'skills' && (!selected || selected.startsWith('skill:'))

  return (
    <aside aria-label="Plugins navigation" className="hidden h-full w-[280px] shrink-0 flex-col border-r border-border bg-background md:flex">
      <div data-tauri-drag-region className="flex h-12 shrink-0 items-center pr-3 pl-3.5" style={!open || isMobile ? { paddingLeft: TITLEBAR_CONTROLS_END } : undefined}>
        <span className="truncate text-sm font-normal text-foreground">Plugins</span>
      </div>
      <div ref={hover.containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-1.5 pb-2">
        <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-none">
          <nav aria-label="Browse" className="flex shrink-0 flex-col gap-0.5">
            <button
              type="button"
              data-active={!selected && tab === 'plugins' ? 'true' : undefined}
              aria-current={!selected && tab === 'plugins' ? 'page' : undefined}
              onClick={() => onSelectTab('plugins')}
              className={SIDEBAR_ROW}
            >
              <BlocksIcon />
              <span className="min-w-0 truncate">Plugins</span>
            </button>
            <button type="button" data-active={skillsActive ? 'true' : undefined} aria-current={skillsActive ? 'page' : undefined} onClick={() => onSelectTab('skills')} className={SIDEBAR_ROW}>
              <BookOpenIcon />
              <span className="min-w-0 truncate">Skills</span>
            </button>
          </nav>

          <nav aria-label="Installed" className="flex shrink-0 flex-col gap-0.5">
            <div className={`${SIDEBAR_SECTION} justify-between gap-2`}>
              <span className="truncate">Installed</span>
              {installed.length > 0 && <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">{installed.length}</span>}
            </div>
            {installed.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">None installed yet</p>
            ) : (
              installed.map((item) => {
                const active = selected === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-active={active ? 'true' : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelectInstalled(item.key)}
                    className={SIDEBAR_ROW}
                  >
                    {item.kind === 'connector' ? <ConnectorIcon connector={item.connector} className="size-3.5" /> : <ServerIcon className="text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{item.kind === 'connector' ? item.connector.name : item.server.name}</span>
                  </button>
                )
              })
            )}
          </nav>
        </div>
      </div>
    </aside>
  )
}
