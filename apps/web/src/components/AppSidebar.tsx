import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { BlocksIcon, BoxIcon, ChevronDownIcon, ChevronRightIcon, ClockFadingIcon, PlusIcon } from 'lucide-react'
import type { DorkState } from '@dorks/shared'
import type { Usage } from '@dorks/client'
import { useBuilds, useDorks, useGithubRepos, useUsage } from '@dorks/client/react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@dorks/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { FluidHoverHighlight } from '@dorks/ui/fluid-hover-highlight'
import { Sidebar, useSidebar } from '@dorks/ui/sidebar'
import githubDark from '../assets/providers/github-dark.svg'
import githubLight from '../assets/providers/github-light.svg'
import { toast } from 'sonner'
import { useArchiveDork } from '../lib/archive'
import { AccountMenu } from './AccountMenu'
import { useDisconnect } from './ConnectionGate'
import { ChatList, type Chat, type ChatPr, type ChatRoute, type PrState } from './ChatList'
import { Logo } from './onboarding/List'
import { OwnerAvatar, ownerOf } from './RepoAvatar'
import { ownersOf, useOwnerScope } from './ownerScope'
import { MODE_ICONS } from './ModeMenu'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from './sidebarChrome'
import { HistoryButtons, TITLEBAR_AFTER_TOGGLE } from './WindowControls'
import { useAppWorkspace, workspaceOf, type AppWorkspace } from './appWorkspace'
import { UpdatePrompt } from './UpdatePrompt'
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
      working: MOVING.has(d.state),
      state: d.state,
      attention: d.needsAttention,
      unread: d.unread,
      prs: prsOf(d),
      mode: d.mode,
      parentId: d.parentId,
    }))
  // Agents' changes waiting for the owner: a count beside Builds, so a proposal is found from anywhere.
  const reviews = (builds ?? []).reduce((n, b) => n + b.drafts.filter((d) => d.status === 'submitted').length, 0)
  return (
    <AppSidebarView
      chats={chats}
      accounts={github}
      counts={{ '/builds': reviews }}
      onDisconnect={disconnect}
      limits={limits}
      version={window.__DORKS__?.version}
      usage={
        <>
          <UpdatePrompt />
        </>
      }
      onArchive={(id) => void archive(id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not archive the chat'))}
    />
  )
}

const ALL = ''

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

/** 16px, but in the rows' 14px icon column (-1px each side), so its label starts where the other rows' do. */
function GithubMark() {
  return <Logo light={githubLight} dark={githubDark} className="-mx-px size-4 shrink-0" />
}

/**
 * The header's switcher, the way an organization switcher works: the current owner (a GitHub user or organization) with its avatar,
 * and a menu to scope the sidebar to another owner or to all of them. Changing the server lives in the account menu at the foot.
 */
function OwnerSwitcher({ owners, scope, setScope }: { owners: string[]; scope: string; setScope: (scope: string) => void }) {
  const name = scope || 'All repositories'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-label={`Switch owner, currently ${name}`} className={`${SIDEBAR_ROW} text-foreground aria-expanded:bg-foreground/[0.05]`}>
        {scope ? <OwnerAvatar owner={scope} className="-mx-px" /> : <GithubMark />}
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDownIcon aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      {/* A little wider than the sidebar's row, so long organization names fit. */}
      <DropdownMenuContent align="start" className="w-[calc(var(--anchor-width)+1.5rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Owners</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={scope} onValueChange={(value) => setScope(value as string)}>
            <DropdownMenuRadioItem value={ALL} closeOnClick>
              <GithubMark />
              <span className="min-w-0 flex-1 truncate">All repositories</span>
            </DropdownMenuRadioItem>
            {owners.map((owner) => (
              <DropdownMenuRadioItem key={owner} value={owner} closeOnClick>
                <OwnerAvatar owner={owner} />
                <span className="min-w-0 flex-1 truncate">{owner}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const WORKSPACES: { value: AppWorkspace; label: string; icon: (typeof MODE_ICONS)[keyof typeof MODE_ICONS] }[] = [
  { value: 'agents', label: 'Agents', icon: MODE_ICONS.code },
  { value: 'chat', label: 'Chat', icon: MODE_ICONS.chat },
]

/**
 * The title bar's workspace switcher (`Agents ⌄`): Agents lists code sessions and nerds, Chat lists chats. Switching away from an open
 * session of the other workspace goes to New session, so the page never shows a session the sidebar does not list.
 */
function WorkspaceSwitcher({ workspace, onChange }: { workspace: AppWorkspace; onChange: (next: AppWorkspace) => void }) {
  const current = WORKSPACES.find((w) => w.value === workspace) ?? WORKSPACES[0]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Switch workspace, currently ${current.label}`}
        className="flex h-7 min-w-0 shrink items-center gap-0.5 rounded-[6px] px-1.5 text-sm text-muted-foreground outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-expanded:bg-foreground/[0.05] aria-expanded:text-foreground"
      >
        <span className="min-w-0 truncate">{current.label}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuRadioGroup value={workspace} onValueChange={(value) => onChange(value as AppWorkspace)}>
          {WORKSPACES.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} closeOnClick>
              <Icon />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The app's pages, under New session. Builds are machines for code, so Chat has none; Plugins are the same in both workspaces. */
const PAGES = [
  { to: '/builds', label: 'Builds', icon: BoxIcon, workspaces: ['agents'] },
  { to: '/automations', label: 'Automations', icon: ClockFadingIcon, workspaces: ['agents', 'chat'] },
  { to: '/plugins', label: 'Plugins', icon: BlocksIcon, workspaces: ['agents', 'chat'] },
] as const

/**
 * The app's sidebar: a 48px title bar (traffic lights, the toggle, the workspace switcher, back and forward); in Agents the owner
 * switcher, New session and the app's pages, then the nerds, then the code sessions of the owner in scope, grouped by repository (a label per repository, alphabetical, that folds its section shut and remembers it),
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
}: {
  chats: Chat[]
  /** A count beside a page in the nav (Builds: agents' changes to review); nothing when zero. */
  counts?: Partial<Record<(typeof PAGES)[number]['to'], number>>
  /** What the GitHub CLI's login can see (`GET /api/github/repos`): its user and organizations fill the owner switcher. */
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
  // One workspace at a time (docs/modes.md): Chat lists the chats; Agents lists the nerds in their own group, then the code sessions by
  // repository. A nerd's workers live inside it, not in the sidebar.
  const [workspace, setWorkspace] = useAppWorkspace()
  const navigate = useNavigate()
  const talks = chats.filter((c) => c.mode === 'chat' && !c.parentId)
  const nerds = chats.filter((c) => c.mode === 'nerd' && !c.parentId)
  const sessions = chats.filter((c) => c.mode !== 'chat' && c.mode !== 'nerd' && !c.parentId)
  // Opening a session of the other workspace (a link, a notification) switches to it, so its row is in view.
  const activeMode = chats.find((c) => c.id === activeId)?.mode
  const activeKnown = chats.some((c) => c.id === activeId)
  useEffect(() => {
    if (activeKnown) setWorkspace(workspaceOf(activeMode))
  }, [activeKnown, activeMode, setWorkspace])
  const switchWorkspace = (next: AppWorkspace) => {
    if (next === workspace) return
    // Leave the open session first, so the effect above does not switch straight back to its workspace; and drop a new session's
    // preset (a repository's or the Nerds group's +), which would otherwise outrank the workspace's mode.
    const { repo, mode } = search as { repo?: unknown; mode?: unknown }
    const leave = (activeKnown && workspaceOf(activeMode) !== next) || (pathname === '/dorks' && (repo !== undefined || mode !== undefined))
    if (leave) void navigate({ to: '/dorks', search: {} }).then(() => setWorkspace(next))
    else setWorkspace(next)
  }
  const owners = ownersOf(
    sessions.flatMap((c) => (c.repo ? [c.repo] : [])),
    accounts,
  )
  const [scope, setScope] = useOwnerScope(owners)
  const inScope = scope ? sessions.filter((c) => c.repo && ownerOf(c.repo) === scope) : sessions
  const repos = new Map<string, Chat[]>()
  for (const chat of inScope) {
    const repo = chat.repo ?? ''
    repos.set(repo, [...(repos.get(repo) ?? []), chat])
  }
  const groups = [...repos].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b)))
  // A section is named by the repository alone (`dorks`), with its owner only when two owners share the name.
  const names = groups.map(([repo]) => nameOf(repo))
  const label = (repo: string) => (!repo ? 'Other' : names.filter((n) => n === nameOf(repo)).length > 1 ? repo : nameOf(repo))
  const [collapsed, toggle] = useCollapsedRepos()
  const hover = useRowHover()
  const rowLink = (active: boolean) => ({ 'data-active': active || undefined, 'aria-current': active ? ('page' as const) : undefined, className: SIDEBAR_ROW })
  return (
    // In a resizable panel on desktop (the frame sizes it), shadcn's sheet on phones.
    <Sidebar collapsible={isMobile ? 'offcanvas' : 'none'} className={isMobile ? undefined : 'h-full w-full'}>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-foreground">
        {/* The title bar: the traffic lights and the floating toggle (AppFrame) sit over its start, then the workspace switcher, and back
            and forward at its end. */}
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-0.5 pr-1.5" style={{ paddingLeft: isMobile ? 6 : TITLEBAR_AFTER_TOGGLE }}>
          <WorkspaceSwitcher workspace={workspace} onChange={switchWorkspace} />
          <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
          {!isMobile && <HistoryButtons />}
        </div>
        <div ref={hover.containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1.5 pb-1.5">
          <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-none">
            <nav aria-label="App" className="flex shrink-0 flex-col gap-0.5">
              {workspace === 'agents' && <OwnerSwitcher owners={owners} scope={scope} setScope={setScope} />}
              {/* A fresh state on every click, so clicking it again while there still counts as a new visit and puts the cursor in the box. */}
              <Link to="/dorks" search={{}} state={(prev) => ({ ...prev, visit: Date.now() })} {...rowLink(pathname === '/dorks' && !activeId)}>
                {/* The plus is a narrow glyph: drawn at 16px in the 14px column so it reads as wide as the page icons under it. */}
                <PlusIcon className="-mx-px size-4!" />
                New session
              </Link>
              {PAGES.filter((page) => (page.workspaces as readonly AppWorkspace[]).includes(workspace)).map(({ to, label, icon: Icon }) => (
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
            {workspace === 'chat' ? (
              <nav aria-label="Chats" className="flex shrink-0 flex-col gap-0.5">
                <ChatList chats={talks} orderKey={`${orderKey}.chats`} to={chatTo} activeId={activeId} onArchive={onArchive} />
              </nav>
            ) : (
              <>
                {nerds.length > 0 && (
                  <Group id="nerds" label="Nerds" add={{ search: { mode: 'nerd' }, label: 'New nerd' }} open={!collapsed.has('nerds')} onOpenChange={(next) => toggle('nerds', next)}>
                    <ChatList chats={nerds} orderKey={`${orderKey}.nerds`} to={chatTo} activeId={activeId} onArchive={onArchive} />
                  </Group>
                )}
                {groups.map(([repo, list]) => {
                  const key = repo || 'other'
                  return (
                    <Group
                      key={key}
                      id={key}
                      label={label(repo)}
                      title={repo || undefined}
                      navLabel={repo || 'Other chats'}
                      add={repo ? { search: { repo }, label: `New session in ${repo}` } : undefined}
                      open={!collapsed.has(key)}
                      onOpenChange={(next) => toggle(key, next)}
                    >
                      <ChatList chats={list} orderKey={`${orderKey}.${key}`} to={chatTo} activeId={activeId} onArchive={onArchive} />
                    </Group>
                  )
                })}
              </>
            )}
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
  title,
  navLabel,
  add,
  open,
  onOpenChange,
  children,
}: {
  id: string
  label: string
  title?: string
  navLabel?: string
  add?: { search: { repo?: string; mode?: 'nerd' }; label: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Collapsible data-group={id} open={open} onOpenChange={onOpenChange} render={<nav aria-label={navLabel ?? label} className="flex shrink-0 flex-col gap-0.5" />}>
      <div className={`group/section ${SIDEBAR_SECTION} pr-1 pl-0`} title={title}>
        <CollapsibleTrigger className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-[6px] pl-2 text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
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
