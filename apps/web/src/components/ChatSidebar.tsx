import type { ReactNode } from 'react'
import { IconPlayCircle, IconPlayground, IconPlusMedium, IconPullRequest, IconPullRequestClosedSimple } from './icons'
import { Sidebar, SidebarGroup, SidebarItem, SidebarSectionHeader, SortableChatList, type Chat, type ChatRoute } from './sidebar'

export type { Chat }

/** The three main navigation rows. */
function MainNav() {
  return (
    <SidebarGroup>
      <SidebarItem icon={IconPlusMedium} label="New session" to="/dorks" />
      {/* No automations route yet. */}
      <SidebarItem icon={IconPlayCircle} label="Automations" onClick={() => {}} />
      <SidebarItem icon={IconPlayground} label="Customize" to="/settings" />
    </SidebarGroup>
  )
}

export type ChatSidebarProps = {
  chats: Chat[]
  nav?: ReactNode
  /** localStorage key prefix for the per-group chat order. */
  orderKey?: string
  /** Route a chat row links to (with `?dork=<id>`). Defaults to /dorks. */
  chatTo?: ChatRoute
}

/**
 * The whole sidebar: main navigation, then the chats split by whether they have a pull request yet ("Ready" has one, "Drafts"
 * does not). Each group is reorderable and remembers its order in localStorage under `orderKey`.
 */
export function ChatSidebar({ chats, nav = <MainNav />, orderKey = 'dorks.chat-order', chatTo }: ChatSidebarProps) {
  const ready = chats.filter((c) => c.pr)
  const drafts = chats.filter((c) => !c.pr)
  return (
    <Sidebar>
      {nav}
      {ready.length > 0 && (
        <SidebarGroup>
          <SidebarSectionHeader icon={IconPullRequest} label="Ready" />
          <SortableChatList chats={ready} orderKey={`${orderKey}.ready`} to={chatTo} />
        </SidebarGroup>
      )}
      {drafts.length > 0 && (
        <SidebarGroup>
          <SidebarSectionHeader icon={IconPullRequestClosedSimple} label="Drafts" />
          <SortableChatList chats={drafts} orderKey={`${orderKey}.drafts`} to={chatTo} />
        </SidebarGroup>
      )}
    </Sidebar>
  )
}
