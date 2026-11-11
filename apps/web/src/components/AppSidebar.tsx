import { useEffect, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { BlocksIcon, BoxIcon, ChevronDownIcon, PlusIcon, ServerIcon, SettingsIcon, WorkflowIcon } from 'lucide-react'
import type { DorkState } from '@dorks/shared'
import { useDorks } from '@dorks/client/react'
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
import { useDisconnect } from './ConnectionGate'
import { ChatList, type Chat, type ChatRoute } from './ChatList'
import { Logo } from './onboarding/List'
import { OwnerAvatar, ownerOf } from './RepoAvatar'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from './sidebarChrome'
import { UsageBar } from './UsageBar'
import { useRowHover } from './useRowHover'

const PR_NUMBER = /\/pull\/(\d+)/

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
  const chats: Chat[] = (dorks ?? []).map((d) => ({ id: d.id, title: d.title, repo: d.repo, working: MOVING.has(d.state), pr: prOf(d.prUrl) }))
  return <AppSidebarView chats={chats} onDisconnect={disconnect} />
}

const ALL = ''
const SCOPE_KEY = 'dorks.owner-scope'

/** The owner the sidebar is scoped to (`ALL` for every chat), remembered per browser. A scope with no chats left falls back to all. */
function useOwnerScope(owners: string[]) {
  const [scope, setScope] = useState(() => localStorage.getItem(SCOPE_KEY) ?? ALL)
  useEffect(() => localStorage.setItem(SCOPE_KEY, scope), [scope])
  return [owners.includes(scope) ? scope : ALL, setScope] as const
}

function GithubMark() {
  return <Logo light={githubLight} dark={githubDark} className="size-4 shrink-0" />
}

/**
 * The header's switcher, the way an organization switcher works: the current owner (a GitHub user or organization) with its avatar,
 * and a menu to scope the sidebar to another owner or to all of them. Below that, the connection: change the server.
 */
function OwnerSwitcher({ owners, scope, setScope, onDisconnect }: { owners: string[]; scope: string; setScope: (scope: string) => void; onDisconnect?: (() => void) | null }) {
  const name = scope || 'All repositories'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Switch owner, currently ${name}`}
        className={`${SIDEBAR_ROW} text-foreground aria-expanded:bg-foreground/[0.05]`}
      >
        {scope ? <OwnerAvatar owner={scope} /> : <GithubMark />}
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDownIcon aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
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

/** The app's pages, under New session. Customize, Automations and Builds are previews: their pages say what will be there. */
const PAGES = [
  { to: '/customize', label: 'Customize', icon: BlocksIcon },
  { to: '/automations', label: 'Automations', icon: WorkflowIcon },
  { to: '/builds', label: 'Builds', icon: BoxIcon },
] as const

/**
 * The app's sidebar: a 48px title bar (traffic lights, the toggle, back and forward); the owner switcher with New session and the
 * app's pages; then the chats of
 * the owner in scope, grouped by repository (a plain label per repository, alphabetical), each group reorderable and remembering its
 * order; Settings at the foot. Rows are 30px, 2px apart, with one hover fill springing between them; groups are 16px apart. It sits
 * flat on the app fill in a resizable panel (see AppFrame); on phones it is shadcn's sheet.
 */
export function AppSidebarView({ chats, onDisconnect, orderKey = 'dorks.chat-order', chatTo }: { chats: Chat[]; onDisconnect?: (() => void) | null; orderKey?: string; chatTo?: ChatRoute }) {
  const { isMobile } = useSidebar()
  const { pathname, search } = useLocation()
  const dork = (search as { dork?: unknown }).dork
  const activeId = typeof dork === 'string' ? dork : undefined
  const owners = [...new Set(chats.flatMap((c) => (c.repo ? [ownerOf(c.repo)] : [])))].sort((a, b) => a.localeCompare(b))
  const [scope, setScope] = useOwnerScope(owners)
  const inScope = scope ? chats.filter((c) => c.repo && ownerOf(c.repo) === scope) : chats
  const repos = new Map<string, Chat[]>()
  for (const chat of inScope) {
    const repo = chat.repo ?? ''
    repos.set(repo, [...(repos.get(repo) ?? []), chat])
  }
  const groups = [...repos].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
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
              <OwnerSwitcher owners={owners} scope={scope} setScope={setScope} onDisconnect={onDisconnect} />
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
            {groups.map(([repo, list]) => (
              <nav key={repo} aria-label={repo || 'Other chats'} className="flex shrink-0 flex-col gap-0.5">
                <div className={`group/section ${SIDEBAR_SECTION} pr-1`} title={repo || undefined}>
                  <span className="min-w-0 flex-1 truncate">{repo ? (scope ? repo.slice(scope.length + 1) : repo) : 'Other'}</span>
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
                <ChatList chats={list} orderKey={`${orderKey}.${repo || 'other'}`} to={chatTo} activeId={activeId} />
              </nav>
            ))}
          </div>
          <div className="flex shrink-0 flex-col gap-2 pt-1.5">
            <UsageBar />
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
