import { Link } from '@tanstack/react-router'
import { GitPullRequestDraftIcon, GitPullRequestIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import type { DorkState } from '@dorks/shared'
import { useDorks } from '@dorks/client/react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@dorks/ui/sidebar'
import { useDisconnect } from './ConnectionGate'
import { ChatList, type Chat, type ChatRoute } from './ChatList'

const PR_NUMBER = /\/pull\/(\d+)/

/** Pull request number from the stored PR url. The backend does not keep the number or merged/closed state yet. */
function prOf(prUrl: string | undefined): Chat['pr'] {
  const n = prUrl && PR_NUMBER.exec(prUrl)?.[1]
  return n ? { number: Number(n) } : undefined
}

/** Dork states in which something is moving. Everything else (idle, sleeping, error) is shown as still. */
const MOVING: ReadonlySet<DorkState> = new Set(['creating', 'working', 'waking'])

/**
 * The app's sidebar, fed from the user's dorks: navigation, then the chats split by whether they have a pull request yet
 * ("Ready" has one, "Drafts" does not). Each group is reorderable and remembers its order. It sits flat on the app fill, divided
 * from the page by a full-height line, and collapses off-canvas from its own toggle.
 */
export function AppSidebar() {
  const dorks = useDorks(false)
  const disconnect = useDisconnect()
  const chats: Chat[] = (dorks ?? []).map((d) => ({ id: d.id, title: d.title, working: MOVING.has(d.state), pr: prOf(d.prUrl) }))
  return <AppSidebarView chats={chats} onDisconnect={disconnect} />
}

/** The sidebar for a given list of chats; the dev preview renders it without a server. */
export function AppSidebarView({ chats, onDisconnect, orderKey = 'dorks.chat-order', chatTo }: { chats: Chat[]; onDisconnect?: (() => void) | null; orderKey?: string; chatTo?: ChatRoute }) {
  const disconnect = onDisconnect
  const ready = chats.filter((c) => c.pr)
  const drafts = chats.filter((c) => !c.pr)
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader data-tauri-drag-region className="h-12 flex-row items-center justify-between px-3 py-0">
        <span className="px-1 text-sm font-medium">Dorks</span>
        <SidebarTrigger className="text-muted-foreground" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/dorks" search={{}} activeOptions={{ exact: true, includeSearch: true }} activeProps={{ 'data-active': true }} />} tooltip="New session">
                  <PlusIcon />
                  <span>New session</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {ready.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel><GitPullRequestIcon className="mr-1.5" />Ready</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <ChatList chats={ready} orderKey={`${orderKey}.ready`} to={chatTo} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {drafts.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel><GitPullRequestDraftIcon className="mr-1.5" />Drafts</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <ChatList chats={drafts} orderKey={`${orderKey}.drafts`} to={chatTo} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/settings" activeProps={{ 'data-active': true }} />} tooltip="Settings">
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {disconnect && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={disconnect}>
                <span className="text-muted-foreground">Change server</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
