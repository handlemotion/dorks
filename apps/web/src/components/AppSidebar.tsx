import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { BlocksIcon, BoxIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, ServerIcon, SettingsIcon, WorkflowIcon } from 'lucide-react'
import type { DorkState } from '@dorks/shared'
import { useDorks, useDorksClient, useGithubRepos } from '@dorks/client/react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@dorks/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { FluidHoverHighlight } from '@dorks/ui/fluid-hover-highlight'
import { Sidebar, useSidebar } from '@dorks/ui/sidebar'
import githubDark from '../assets/providers/github-dark.svg'
import githubLight from '../assets/providers/github-light.svg'
import { GH_ORG_ACCESS_URL } from '../lib/github'
import { useDisconnect } from './ConnectionGate'
import { ChatList, type Chat, type ChatRoute } from './ChatList'
import { Logo } from './onboarding/List'
import { OwnerAvatar, ownerOf } from './RepoAvatar'
import { ownersOf, useOwnerScope } from './ownerScope'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from './sidebarChrome'
import { UsageBar } from './UsageBar'
import { useRowHover } from './useRowHover'

const PR_NUMBER = /\/pull\/(\d+)/

/** The name of an `owner/name` repository. */
const nameOf = (repo: string) => repo.slice(repo.indexOf('/') + 1)

/** Pull request number from the stored PR url. The backend does not keep the number or merged/closed state yet. */
function prOf(prUrl: string | undefined): Chat['pr'] {
  const n = prUrl && PR_NUMBER.exec(prUrl)?.[1]
  return n ? { number: Number(n) } : undefined
}

/** Dork states in which something is moving. Everything else (idle, sleeping, error) is shown as still. */
const MOVING: ReadonlySet<DorkState> = new Set(['creating', 'working', 'waking'])

export function AppSidebar() {
  const dorks = useDorks(false)
  const disconnect = useDisconnect()
  const github = useGithubRepos()
  const { actions } = useDorksClient()
  const chats: Chat[] = (dorks ?? []).map((d) => ({ id: d.id, title: d.title, repo: d.repo, working: MOVING.has(d.state), pr: prOf(d.prUrl) }))
  return <AppSidebarView chats={chats} accounts={github} onDisconnect={disconnect} onAddOrganization={() => addOrganization(actions.refreshGithub)} usage={<UsageBar />} />
}

/**
 * Organizations come from the GitHub CLI's login. One missing from the switcher has not granted the GitHub CLI access (an OAuth app
 * policy), so this opens GitHub's page to request it, and reads GitHub again when the window is back in focus.
 */
function addOrganization(refresh: () => Promise<void>) {
  window.open(GH_ORG_ACCESS_URL, '_blank', 'noopener')
  window.addEventListener('focus', () => void refresh().catch(() => {}), { once: true })
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

function GithubMark() {
  return <Logo light={githubLight} dark={githubDark} className="size-4 shrink-0" />
}

/**
 * The header's switcher, the way an organization switcher works: the current owner (a GitHub user or organization) with its avatar,
 * and a menu to scope the sidebar to another owner or to all of them. Below that, the connection: change the server.
 */
function OwnerSwitcher({
  owners,
  scope,
  setScope,
  onDisconnect,
  onAddOrganization,
}: {
  owners: string[]
  scope: string
  setScope: (scope: string) => void
  onDisconnect?: (() => void) | null
  onAddOrganization?: () => void
}) {
  const name = scope || 'All repositories'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-label={`Switch owner, currently ${name}`} className={`${SIDEBAR_ROW} text-foreground aria-expanded:bg-foreground/[0.05]`}>
        {scope ? <OwnerAvatar owner={scope} /> : <GithubMark />}
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
        <DropdownMenuSeparator />
        {onAddOrganization && (
          <DropdownMenuItem onClick={onAddOrganization}>
            <PlusIcon />
            <span className="min-w-0 flex-1 truncate">Add organization</span>
          </DropdownMenuItem>
        )}
        {onDisconnect && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDisconnect}>
              <ServerIcon />
              Change server
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The app's pages, under New session. Customize and Automations are previews: their pages say what will be there. */
const PAGES = [
  { to: '/customize', label: 'Customize', icon: BlocksIcon },
  { to: '/automations', label: 'Automations', icon: WorkflowIcon },
  { to: '/builds', label: 'Builds', icon: BoxIcon },
] as const

/**
 * The app's sidebar: a 48px title bar (traffic lights, the toggle, back and forward); the owner switcher with New session and the
 * app's pages; then the chats of
 * the owner in scope, grouped by repository (a label per repository, alphabetical, that folds its section shut and remembers it),
 * each group reorderable and remembering its order; Settings at the foot. Rows are 30px, 2px apart, with one hover fill springing between them; groups are 16px apart. It sits
 * flat on the app fill in a resizable panel (see AppFrame); on phones it is shadcn's sheet.
 */
/** The sidebar from props alone. `usage` is the slot above Settings: the live `<UsageBar />` in the app, static data (or nothing) in demos. */
export function AppSidebarView({
  chats,
  accounts,
  onDisconnect,
  onAddOrganization,
  orderKey = 'dorks.chat-order',
  chatTo,
  usage,
}: {
  chats: Chat[]
  /** What the GitHub CLI's login can see (`GET /api/github/repos`): its user and organizations fill the owner switcher. */
  accounts?: { login: string | null; orgs: string[]; repos: string[] }
  onDisconnect?: (() => void) | null
  /** "Add organization" in the owner switcher; hidden without it. */
  onAddOrganization?: () => void
  orderKey?: string
  chatTo?: ChatRoute
  usage?: ReactNode
}) {
  const { isMobile } = useSidebar()
  const { pathname, search } = useLocation()
  const dork = (search as { dork?: unknown }).dork
  const activeId = typeof dork === 'string' ? dork : undefined
  const owners = ownersOf(
    chats.flatMap((c) => (c.repo ? [c.repo] : [])),
    accounts,
  )
  const [scope, setScope] = useOwnerScope(owners)
  const inScope = scope ? chats.filter((c) => c.repo && ownerOf(c.repo) === scope) : chats
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
        <div ref={hover.containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1.5 pt-1 pb-1.5">
          <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain">
            <nav aria-label="App" className="flex shrink-0 flex-col gap-0.5">
              <OwnerSwitcher owners={owners} scope={scope} setScope={setScope} onDisconnect={onDisconnect} onAddOrganization={onAddOrganization} />
              <Link to="/dorks" search={{}} {...rowLink(pathname === '/dorks' && !activeId)}>
                <PlusIcon />
                New session
              </Link>
              {PAGES.map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} {...rowLink(pathname === to)}>
                  <Icon />
                  {label}
                </Link>
              ))}
            </nav>
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
                    <ChatList chats={list} orderKey={`${orderKey}.${key}`} to={chatTo} activeId={activeId} />
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
          <div className="flex shrink-0 flex-col gap-2 pt-1.5">
            {usage}
            <Link to="/settings" {...rowLink(pathname === '/settings')}>
              <SettingsIcon />
              Settings
            </Link>
          </div>
        </div>
      </div>
    </Sidebar>
  )
}
