import type { SubscriptionView } from '@dorks/shared'
import { Link, type RegisteredRouter } from '@tanstack/react-router'
import { move } from '@dnd-kit/helpers'
import { Accessibility, defaultPreset, KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { useStoredOrder } from '../lib/storedOrder'
import { Orb } from './Orb'
import { SIDEBAR_ROW } from './sidebarChrome'

export type PrState = SubscriptionView['state']

/** What the sidebar shows of a chat (a dork). */
export type Chat = {
  /** Dork id, passed through as the `dork` search param of the chat route. */
  id: string
  title: string
  /** `owner/name`; the sidebar's owner switcher filters by its owner. */
  repo?: string
  /** Something is moving in this chat. The sidebar shows only this; richer states (sleeping, error) live in the chat itself. */
  working: boolean
  pr?: { number: number; state?: PrState }
}

type RoutesByPath = RegisteredRouter['routesByPath']
/** Every route that selects a chat through a `dork` search param, read from the route tree. */
export type ChatRoute = {
  [P in keyof RoutesByPath]: 'dork' extends keyof RoutesByPath[P]['types']['fullSearchSchema'] ? P : never
}[keyof RoutesByPath]

/**
 * Pointer: on mouse and pen only movement starts a drag. The default also starts one after a 200ms hold, which turns a slow
 * click into a drag and swallows the navigation. Touch keeps the library's long press so the list still scrolls.
 * Keyboard: Space picks a row up. The default also uses Enter, which would pick the link up instead of following it.
 */
const SENSORS = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor.configure({ keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] } }),
]

type Source = DragStartEvent['operation']['source']
const titleOf = (source: Source) => (source?.data as Chat | undefined)?.title ?? 'Chat'
const positionOf = (source: Source) => (isSortable(source) ? ` to position ${source.index + 1}` : '')

/** Screen reader announcements that name the chat and its position; the defaults read out raw dork ids. */
const PLUGINS = [
  ...defaultPreset.plugins.filter((plugin) => plugin !== Accessibility),
  Accessibility.configure({
    announcements: {
      dragstart: ({ operation: { source } }: DragStartEvent) => `Picked up ${titleOf(source)}.`,
      dragover: ({ operation: { source } }: DragOverEvent) => `${titleOf(source)} moved${positionOf(source)}.`,
      dragend: ({ operation: { source }, canceled }: DragEndEvent) =>
        canceled ? `Reordering canceled. ${titleOf(source)} is back in place.` : `${titleOf(source)} dropped${positionOf(source)}.`,
    },
  }),
]

/**
 * Chats the user can reorder by dragging (or Space + arrow keys). The order is remembered per browser under `orderKey`.
 * One provider per list, so a chat cannot be dragged into another list.
 */
export function ChatList({ chats, orderKey, to = '/dorks' as ChatRoute, activeId }: { chats: Chat[]; orderKey: string; to?: ChatRoute; /** The chat open in the page. */ activeId?: string }) {
  const [order, setOrder] = useStoredOrder(orderKey, chats.map((c) => c.id))
  const byId = new Map(chats.map((c) => [c.id, c]))
  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragEnd={(event) => {
        if (event.canceled) return
        const next = move(order, event)
        if (next !== order) setOrder(next)
      }}
    >
      {order.map((id, index) => (
        <ChatItem key={id} chat={byId.get(id)!} index={index} to={to} active={id === activeId} />
      ))}
    </DragDropProvider>
  )
}

/**
 * A chat row. The leading Orb animates while the chat is working and settles into a small dot when it is not; the right edge
 * shows the pull request number, colored by PR state, when the chat has opened one. The row is active (`data-active`,
 * `aria-current`) while its chat is the one in the URL.
 */
function ChatItem({ chat, index, to, active }: { chat: Chat; index: number; to: ChatRoute; active: boolean }) {
  // `data` feeds announcements; the link is the handle so interactive-element filtering allows row drags.
  const { ref, handleRef, isDragging } = useSortable({ id: chat.id, index, data: chat })
  return (
    <div ref={ref} data-dragging={isDragging || undefined} className="relative flex min-w-0 data-[dragging]:z-30 data-[dragging]:opacity-60">
      <Link
        ref={handleRef}
        to={to}
        search={{ dork: chat.id }}
        data-active={active || undefined}
        aria-current={active ? 'page' : undefined}
        // Explicit, so dnd-kit's accessibility plugin does not turn the link into role="button" when the row is sortable.
        role="link"
        draggable={false}
        data-working={chat.working || undefined}
        title={chat.title}
        className={`${SIDEBAR_ROW} ${chat.pr ? 'pr-12' : ''}`}
      >
        <Orb size={14} working={chat.working} label={chat.working ? 'Working…' : 'Idle'} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      </Link>
      {chat.pr && (
        <span
          data-pr={chat.pr.state ?? 'open'}
          className="pointer-events-none absolute top-1/2 right-2 z-20 -translate-y-1/2 text-xs tabular-nums data-[pr=closed]:text-muted-foreground data-[pr=merged]:text-violet-600 data-[pr=open]:text-emerald-600 dark:data-[pr=merged]:text-violet-400 dark:data-[pr=open]:text-emerald-400"
        >
          #{chat.pr.number}
        </span>
      )}
    </div>
  )
}
