import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { BlocksIcon, BoxIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, WorkflowIcon } from 'lucide-react'
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
import { SIDEBAR_ROW, SIDEBAR_SECTION } from './sidebarChrome'
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
  // A nerd has no repository of its own: it sits with the repository of the build it works on (its first), else in Other.
  const buildRepo = new Map((builds ?? []).map((b) => [b.id, b.repos[0]?.repo ?? '']))
  // Newest first by creation, never by activity: rows stay where they are until the owner drags them (ChatList remembers that order).
  const chats: Chat[] = (dorks ?? [])
    .toSorted((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      title: d.title,
      repo: d.mode === 'nerd' && !d.repo ? (buildRepo.get(d.buildId ?? '') ?? '') : d.repo,
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

/** Chats shown before Show more, so the repository groups stay in view under them. */
const CHATS_SHOWN = 5

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

/** The app's pages, under New session. */
const PAGES = [
  { to: '/plugins', label: 'Plugins', icon: BlocksIcon },
  { to: '/automations', label: 'Automations', icon: WorkflowIcon },
  { to: '/builds', label: 'Builds', icon: BoxIcon },
] as const

/**
 * The app's sidebar: a 48px title bar (traffic lights, the toggle, back and forward); the owner switcher with New session and the
 * app's pages; then the chats of
 * the owner in scope, grouped by repository (a label per repository, alphabetical, that folds its section shut and remembers it),
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
  // Chats (docs/modes.md) come first in their own group; nerds sit in the repository groups with the sessions of their build. A nerd's
  // workers live inside it, not in the sidebar.
  const talks = chats.filter((c) => c.mode === 'chat' && !c.parentId)
  const sessions = chats.filter((c) => c.mode !== 'chat' && !c.parentId)
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
        {/* The title bar: the traffic lights and the floating controls (AppFrame) sit over it. Nothing else lives up here. */}
        <div data-tauri-drag-region className="h-12 shrink-0" />
        <div ref={hover.containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1.5 pb-1.5">
          <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-none">
            <nav aria-label="App" className="flex shrink-0 flex-col gap-0.5">
              <OwnerSwitcher owners={owners} scope={scope} setScope={setScope} />
              {/* A fresh state on every click, so clicking it again while there still counts as a new visit and puts the cursor in the box. */}
              <Link to="/dorks" search={{}} state={(prev) => ({ ...prev, visit: Date.now() })} {...rowLink(pathname === '/dorks' && !activeId)}>
                {/* The plus is a narrow glyph: drawn at 16px in the 14px column so it reads as wide as the page icons under it. */}
                <PlusIcon className="-mx-px size-4!" />
                New session
              </Link>
              {PAGES.map(({ to, label, icon: Icon }) => (
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
            {talks.length > 0 && (
              <nav aria-label="Chats" className="flex shrink-0 flex-col gap-0.5">
                <div className={`${SIDEBAR_SECTION} pr-1`}>
                  <span className="min-w-0 flex-1 truncate">Chats</span>
                </div>
                <ChatList chats={talks} orderKey={`${orderKey}.chats`} to={chatTo} activeId={activeId} onArchive={onArchive} limit={CHATS_SHOWN} />
              </nav>
            )}
            {groups.map(([repo, list]) => {
              const key = repo || 'other'
              const open = !collapsed.has(key)
              return (
                <Collapsible key={key} open={open} onOpenChange={(next) => toggle(key, next)} render={<nav aria-label={repo || 'Other chats'} className="flex shrink-0 flex-col gap-0.5" />}>
                  <div className={`group/section ${SIDEBAR_SECTION} pr-1 pl-0`} title={repo || undefined}>
                    <CollapsibleTrigger className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-[6px] pl-2 text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                      <span className="min-w-0 truncate">{label(repo)}</span>
                      <ChevronRightIcon aria-hidden className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                    </CollapsibleTrigger>
                    {repo && (
                      <Link
                        to="/dorks"
                        search={{ repo }}
                        aria-label={`New session in ${repo}`}
                        title={`New session in ${repo}`}
                        className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 outline-none group-hover/section:opacity-100 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(hover:none)]:opacity-100"
                      >
                        <PlusIcon aria-hidden className="size-3.5" />
                      </Link>
                    )}
                  </div>
                  <CollapsibleContent className="flex flex-col gap-0.5">
                    <ChatList chats={list} orderKey={`${orderKey}.${key}`} to={chatTo} activeId={activeId} onArchive={onArchive} />
                  </CollapsibleContent>
                </Collapsible>
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
