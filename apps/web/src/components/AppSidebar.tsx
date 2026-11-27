import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { BlocksIcon, BoxIcon, ChevronRightIcon, ClockFadingIcon, PlusIcon } from 'lucide-react'
import type { DorkLocation, DorkState } from '@dorks/shared'
import type { Usage } from '@dorks/client'
import { useAutomations, useBuilds, useDorks, useGithubRepos, useUsage } from '@dorks/client/react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@dorks/ui/collapsible'
import { FluidHoverHighlight } from '@dorks/ui/fluid-hover-highlight'
import { Sidebar, useSidebar } from '@dorks/ui/sidebar'
import { toast } from 'sonner'
import { useArchiveDork } from '../lib/archive'
import { AccountMenu } from './AccountMenu'
import { useDisconnect } from './ConnectionGate'
import { ChatList, type Chat, type ChatPr, type ChatRoute, type PrState } from './ChatList'
import { MachineRow, OrgSwitcher, StaticOrgSwitcher } from './OrgSwitcher'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from './sidebarChrome'
import { HistoryButtons, TITLEBAR_AFTER_TOGGLE } from './WindowControls'
import { useIsTeamOrg } from './CloudPlace'
import { HERE, LOCATION_ICONS } from './LocationMenu'
import { UpdatePrompt } from './UpdatePrompt'
import { CloudPlanIndicator } from './CloudPlanIndicator'
import { useRowHover } from './useRowHover'

const PR_NUMBER = /\/pull\/(\d+)/

/** The name of an `owner/name` repository. */
const nameOf = (repo: string) => repo.slice(repo.indexOf('/') + 1)

/** The session's pull requests; from an older server, which only names its latest, that one alone. */
function prsOf(d: { prs?: ChatPr[]; prUrl?: string; prState?: PrState }): ChatPr[] {
  if (d.prs?.length) return d.prs
  const n = d.prUrl && PR_NUMBER.exec(d.prUrl)?.[1]
  return n ? [{ number: Number(n), url: d.prUrl, state: d.prState }] : []
}

/** Dork states in which something is moving. Everything else (idle, sleeping, error) is shown as still. */
const MOVING: ReadonlySet<DorkState> = new Set(['creating', 'working', 'waking'])

export function AppSidebar() {
  const dorks = useDorks(false)
  const disconnect = useDisconnect()
  const github = useGithubRepos()
  const limits = useUsage()
  const archive = useArchiveDork()
  const builds = useBuilds()
  // Newest first by creation, never by activity: rows stay where they are until the owner drags them (ChatList remembers that order).
  const chats: Chat[] = (dorks ?? [])
    .toSorted((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      title: d.title,
      repo: d.repo,
      location: d.location,
      working: MOVING.has(d.state),
      state: d.state,
      attention: d.needsAttention,
      unread: d.unread,
      prs: prsOf(d),
      mode: d.mode,
      parentId: d.parentId,
      createdBy: d.createdBy,
    }))
  // Agents' changes waiting for the owner: a count beside Builds, so a proposal is found from anywhere.
  // Automations are a team's: a personal org has no server that is always on to run them (this Mac sleeps, goes offline).
  // Until a personal org's existing ones are deleted, the page stays so they can still be paused or deleted.
  const team = useIsTeamOrg()
  const existing = (useAutomations()?.length ?? 0) > 0
  const reviews = (builds ?? []).reduce((n, b) => n + b.drafts.filter((d) => d.status === 'submitted').length, 0)
  return (
    <AppSidebarView
      chats={chats}
      accounts={github}
      counts={{ '/builds': reviews }}
      automations={team || existing}
      onDisconnect={disconnect}
      switcher={<OrgSwitcher login={github?.login} />}
      machines={<MachineRow />}
      limits={limits}
      version={window.__DORKS__?.version}
      usage={
        <>
          <CloudPlanIndicator />
          <UpdatePrompt />
        </>
      }
      onArchive={(id) => void archive(id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not archive the chat'))}
    />
  )
}

/**
 * The code sessions' sections (docs/local-dorks.md): one per repository and place, its sessions on this computer apart from its cloud
 * ones, which run on a build. Alphabetical by repository name, a repository's cloud section before its local one, Other last. A cloud
 * section keeps the repository as its key (folded state and row order remembered from before local sessions). Once any session runs
 * locally (`placed`), every section says where its sessions run. A section is named by the repository alone (`dorks`), with its owner
 * only when two owners share the name.
 */
function repoSections(sessions: Chat[]) {
  const sections = new Map<string, { repo: string; location: DorkLocation; list: Chat[] }>()
  for (const chat of sessions) {
    const repo = chat.repo ?? ''
    const location = chat.location ?? 'cloud'
    const key = location === 'local' ? `local:${repo || 'other'}` : repo || 'other'
    const section = sections.get(key) ?? { repo, location, list: [] }
    section.list.push(chat)
    sections.set(key, section)
  }
  const groups = [...sections].sort(
    ([, a], [, b]) =>
      (a.repo === '' ? 1 : 0) - (b.repo === '' ? 1 : 0) ||
      nameOf(a.repo).localeCompare(nameOf(b.repo)) ||
      a.repo.localeCompare(b.repo) ||
      (a.location === 'local' ? 1 : 0) - (b.location === 'local' ? 1 : 0),
  )
  const placed = groups.some(([, g]) => g.location === 'local')
  const names = [...new Set(groups.map(([, g]) => g.repo))].map(nameOf)
  const label = (repo: string) => (!repo ? 'Other' : names.filter((n) => n === nameOf(repo)).length > 1 ? repo : nameOf(repo))
  return { groups, placed, label }
}

const COLLAPSED_KEY = 'dorks.collapsed-repos'

/** The repository sections folded shut, remembered per browser. */
function useCollapsedRepos() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    } catch {
      // Not remembered.
    }
  }, [collapsed])
  const toggle = (repo: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (open) next.delete(repo)
      else next.add(repo)
      return next
    })
  return [collapsed, toggle] as const
}

/** The app's pages, under New session. */
const PAGES = [
  { to: '/builds', label: 'Builds', icon: BoxIcon },
  { to: '/automations', label: 'Automations', icon: ClockFadingIcon },
  { to: '/plugins', label: 'Plugins', icon: BlocksIcon },
] as const

/**
 * The app's sidebar: a 48px title bar (traffic lights, the toggle, back and forward); the org switcher (where
 * you work), the Mac the org is connected to when it has several, New session and the app's pages, then the nerds, then the code
 * sessions, grouped by repository and where they run (a label per repository, alphabetical, its local sessions in a section of their
 * own after its cloud one, each with a Cloud or Laptop icon once any session runs locally; a label folds its section shut and remembers it),
 * each group reorderable and remembering its order; the account menu (the owner's avatar) at the foot. Rows are 30px, 2px apart, with one hover fill springing between them; groups are 16px apart. It sits
 * flat on the app fill in a resizable panel (see AppFrame); on phones it is shadcn's sheet.
 */
/** The sidebar from props alone. `usage` is the slot above the account menu: the live update prompt in the app, static data (or nothing) in demos. */
export function AppSidebarView({
  chats,
  accounts,
  onDisconnect,
  orderKey = 'dorks.chat-order',
  chatTo,
  usage,
  limits,
  version,
  onArchive,
  counts,
  switcher,
  machines,
  automations = true,
}: {
  chats: Chat[]
  /** Whether the nav lists Automations: only a team org runs them (a personal org has no always-on server). */
  automations?: boolean
  /** The org switcher (OrgSwitcher); a static Personal row without one (demos). */
  switcher?: ReactNode
  /** Under it, inside an org with several Macs: which one the app is connected to (MachineRow). */
  machines?: ReactNode
  /** A count beside a page in the nav (Builds: agents' changes to review); nothing when zero. */
  counts?: Partial<Record<(typeof PAGES)[number]['to'], number>>
  /** What the GitHub CLI's login can see (`GET /api/github/repos`): the account menu shows its login. */
  accounts?: { login: string | null; orgs: string[]; repos: string[] }
  onDisconnect?: (() => void) | null
  orderKey?: string
  chatTo?: ChatRoute
  usage?: ReactNode
  /** The agents' and Boat's usage, for the account menu's Usage. */
  limits?: Usage
  /** The running app's version (the desktop shell's), shown in the account menu. */
  version?: string
  /** Archives a chat from its row (hover button, right-click menu). */
  onArchive?: (id: string) => void
}) {
  const { isMobile } = useSidebar()
  const { pathname, search } = useLocation()
  const dork = (search as { dork?: unknown }).dork
  const selected = typeof dork === 'string' ? dork : undefined
  // A worker open full screen keeps its dork highlighted: workers have no rows of their own.
  const activeId = chats.find((c) => c.id === selected)?.parentId ?? selected
  // The nerds in their own group, then the code sessions by repository (docs/modes.md). A nerd's workers live inside it, not in the
  // sidebar.
  const nerds = chats.filter((c) => c.mode === 'nerd' && !c.parentId)
  const sessions = chats.filter((c) => c.mode !== 'nerd' && !c.parentId)
  const { groups, placed, label } = repoSections(sessions)
  const [collapsed, toggle] = useCollapsedRepos()
  const hover = useRowHover()
  const rowLink = (active: boolean) => ({ 'data-active': active || undefined, 'aria-current': active ? ('page' as const) : undefined, className: SIDEBAR_ROW })
  return (
    // In a resizable panel on desktop (the frame sizes it), shadcn's sheet on phones.
    <Sidebar collapsible={isMobile ? 'offcanvas' : 'none'} className={isMobile ? undefined : 'h-full w-full'}>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-foreground">
        {/* The title bar: the traffic lights and the floating toggle (AppFrame) sit over its start, back and forward at its end. */}
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-0.5 pr-1.5" style={{ paddingLeft: isMobile ? 6 : TITLEBAR_AFTER_TOGGLE }}>
          <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
          {!isMobile && <HistoryButtons />}
        </div>
        <div ref={hover.containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1.5 pb-1.5">
          <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-none">
            <nav aria-label="App" className="flex shrink-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-0.5">{switcher ?? <StaticOrgSwitcher login={accounts?.login} />}</div>
              {machines}
              {/* A fresh state on every click, so clicking it again while there still counts as a new visit and puts the cursor in the box. */}
              <Link to="/dorks" search={{}} state={(prev) => ({ ...prev, visit: Date.now() })} {...rowLink(pathname === '/dorks' && !activeId)}>
                {/* The plus is a narrow glyph: drawn at 16px in the 14px column so it reads as wide as the page icons under it. */}
                <PlusIcon className="-mx-px size-4!" />
                New session
              </Link>
              {PAGES.filter((page) => automations || page.to !== '/automations').map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} {...rowLink(pathname === to)}>
                  <Icon />
                  {label}
                  {!!counts?.[to] && (
                    <span
                      aria-label={`${counts[to]} to review`}
                      className="ms-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[11px] leading-none text-brand-foreground tabular-nums"
                    >
                      {counts[to]}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
            {/* Always shown: its + is where a nerd starts (the composer has no mode menu). */}
            <Group id="nerds" label="Nerds" add={{ search: { mode: 'nerd' }, label: 'New nerd' }} open={!collapsed.has('nerds')} onOpenChange={(next) => toggle('nerds', next)}>
              <ChatList chats={nerds} orderKey={`${orderKey}.nerds`} to={chatTo} activeId={activeId} onArchive={onArchive} />
            </Group>
            {groups.map(([key, { repo, location, list }]) => {
              const local = location === 'local'
              const where = local ? ` on ${HERE}` : placed ? ' in the cloud' : ''
              return (
                <Group
                  key={key}
                  id={key}
                  label={label(repo)}
                  icon={placed ? LOCATION_ICONS[location] : undefined}
                  title={repo ? `${repo}${where}` : undefined}
                  navLabel={`${repo || 'Other chats'}${where}`}
                  add={repo ? { search: { repo, ...(placed ? { location } : {}) }, label: `New session in ${repo}${where}` } : undefined}
                  open={!collapsed.has(key)}
                  onOpenChange={(next) => toggle(key, next)}
                >
                  <ChatList chats={list} orderKey={`${orderKey}.${key}`} to={chatTo} activeId={activeId} onArchive={onArchive} />
                </Group>
              )
            })}
          </div>
          <div className="flex shrink-0 flex-col gap-2 pt-1.5">
            {usage}
            <AccountMenu login={accounts?.login} version={version} usage={limits} onDisconnect={onDisconnect} />
          </div>
        </div>
      </div>
    </Sidebar>
  )
}

/**
 * A group of rows under a label that folds it shut (remembered), with a + on hover that starts a session for the group (a repository's,
 * or a nerd).
 */
function Group({
  id,
  label,
  icon: Icon,
  title,
  navLabel,
  add,
  open,
  onOpenChange,
  children,
}: {
  id: string
  label: string
  /** Where the section's sessions run, before its label: shown once some sessions run locally. */
  icon?: (typeof LOCATION_ICONS)[DorkLocation]
  title?: string
  navLabel?: string
  add?: { search: { repo?: string; location?: DorkLocation; mode?: 'nerd' }; label: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Collapsible data-group={id} open={open} onOpenChange={onOpenChange} render={<nav aria-label={navLabel ?? label} className="flex shrink-0 flex-col gap-0.5" />}>
      <div className={`group/section ${SIDEBAR_SECTION} pr-1 pl-0`} title={title}>
        <CollapsibleTrigger className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-[6px] pl-2 text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronRightIcon aria-hidden className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        </CollapsibleTrigger>
        {add && (
          <Link
            to="/dorks"
            search={add.search}
            aria-label={add.label}
            title={add.label}
            className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 outline-none group-hover/section:opacity-100 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(hover:none)]:opacity-100"
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      <CollapsibleContent className="flex flex-col gap-0.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}
