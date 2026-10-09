import type { SubscriptionView } from '@dorks/shared'
import { Link, type RegisteredRouter } from '@tanstack/react-router'
import type { Ref } from 'react'
import { Orb } from '../Orb'
import { ROW_ACTIVE_PROPS, SidebarRowContent } from './SidebarRow'

export type PrState = SubscriptionView['state']

export type PullRequest = { number: number; state?: PrState }

/** What the sidebar shows of a chat (a dork). */
export type Chat = {
  /** Dork id, passed through as the `dork` search param of the chat route. */
  id: string
  title: string
  /** Something is moving in this chat. The sidebar shows only this; richer states (sleeping, error) live in the chat itself. */
  working: boolean
  pr?: PullRequest
}

type RoutesByPath = RegisteredRouter['routesByPath']
/** Every route that selects a chat through a `dork` search param, read from the route tree. */
export type ChatRoute = {
  [P in keyof RoutesByPath]: 'dork' extends keyof RoutesByPath[P]['types']['fullSearchSchema'] ? P : never
}[keyof RoutesByPath]

export type ChatLinkProps = Chat & {
  /** Route the row links to, with `?dork=<id>`. Defaults to /dorks. */
  to?: ChatRoute
  dragging?: boolean
  ref?: Ref<HTMLAnchorElement>
}

/**
 * A chat in the sidebar. The leading Orb animates while the chat is working and settles into a small dot when it is not;
 * the right edge shows the pull request number, colored by PR state, when the chat has opened one. The row is active
 * (`data-active`, `aria-current`) while its chat is the one in the URL.
 */
export function ChatLink({ id, title, working, pr, to = '/dorks', dragging, ref }: ChatLinkProps) {
  return (
    <Link
      ref={ref}
      to={to}
      search={{ dork: id }}
      activeProps={ROW_ACTIVE_PROPS}
      className="sidebar-row chat-link"
      // Explicit, so dnd-kit's accessibility plugin does not turn the link into role="button" when the row is sortable.
      role="link"
      data-working={working || undefined}
      data-dragging={dragging || undefined}
      draggable={false}
    >
      <SidebarRowContent
        cell={<Orb className="chat-link-marker" working={working} />}
        label={title}
        meta={pr && <span className="sidebar-row-meta chat-link-pr" data-pr={pr.state ?? 'open'}>#{pr.number}</span>}
      />
    </Link>
  )
}
