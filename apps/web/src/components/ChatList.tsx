import type { DorkState, SubscriptionView } from '@dorks/shared'
import { Link, useRouter, type RegisteredRouter } from '@tanstack/react-router'
import { move } from '@dnd-kit/helpers'
import { Accessibility, defaultPreset, KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { ArchiveIcon, LinkIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@dorks/ui/context-menu'
import { DropdownMenuItem } from '@dorks/ui/dropdown-menu'
import { useStoredOrder } from '../lib/storedOrder'
import { Tip } from './Tip'
import { DorkIcon, dorkIconState } from './DorkIcon'
import { SIDEBAR_ROW } from './sidebarChrome'
import { prStatus } from './PrStatus'

export type PrState = SubscriptionView['state']

/** What the sidebar shows of a chat (a dork). */
export type Chat = {
  /** Dork id, passed through as the `dork` search param of the chat route. */
  id: string
  title: string
  /** `owner/name`; the sidebar's owner switcher filters by its owner. */
  repo?: string
  /** Something is moving in this chat. */
  working: boolean
  /** Lifecycle state of the dork, used to distinguish working (animated), awake (coloured) and asleep (grey). */
  state?: DorkState
  pr?: { number: number; state?: PrState }
  /** A dork (coordinator) shows its emoji instead of the working icon (docs/crew.md). */
  icon?: string
  kind?: 'agent' | 'coordinator'
  /** A worker's coordinator: workers live inside their dork, not in the sidebar. */
  parentId?: string | null
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
      event.pointerType === 'touch' ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })] : [new PointerActivationConstraints.Distance({ value: 5 })],
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
      dragend: ({ operation: { source }, canceled }: DragEndEvent) => (canceled ? `Reordering canceled. ${titleOf(source)} is back in place.` : `${titleOf(source)} dropped${positionOf(source)}.`),
    },
  }),
]

/**
 * Chats the user can reorder by dragging (or Space + arrow keys). The order is remembered per browser under `orderKey`.
 * One provider per list, so a chat cannot be dragged into another list.
 */
export function ChatList({
  chats,
  orderKey,
  to = '/dorks' as ChatRoute,
  activeId,
  onArchive,
}: {
  chats: Chat[]
  orderKey: string
  to?: ChatRoute
  /** The chat open in the page. */
  activeId?: string
  /** Archives a chat: the row's hover button and its right-click menu. Without it, neither shows. */
  onArchive?: (id: string) => void
}) {
  const [order, setOrder] = useStoredOrder(
    orderKey,
    chats.map((c) => c.id),
  )
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
        <ChatItem key={id} chat={byId.get(id)!} index={index} to={to} active={id === activeId} onArchive={onArchive} />
      ))}
    </DragDropProvider>
  )
}

/**
 * A chat row. The leading DorkIcon animates with colour while the chat is working, rests coloured when awake, and turns grey when
 * asleep; the right edge shows the pull request number, colored by PR state, when the chat has opened one. The row is active
 * (`data-active`, `aria-current`) while its chat is the one in the URL. With `onArchive`, hovering the row swaps the PR number
 * for an archive button, and a right click opens the row's menu.
 */
function ChatItem({ chat, index, to, active, onArchive }: { chat: Chat; index: number; to: ChatRoute; active: boolean; onArchive?: (id: string) => void }) {
  // `data` feeds announcements; the link is the handle so interactive-element filtering allows row drags.
  const { ref, handleRef, isDragging } = useSortable({ id: chat.id, index, data: chat })
  const router = useRouter()
  const iconState = dorkIconState(chat.state, { working: chat.working })
  const iconLabel = iconState === 'working' ? 'Working…' : iconState === 'awake' ? 'Awake' : iconState === 'error' ? 'Error' : 'Asleep'
  const row = (
    <div ref={ref} data-chat-id={chat.id} data-dragging={isDragging || undefined} className="group/row relative flex min-w-0 data-[dragging]:z-30 data-[dragging]:opacity-60">
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
        className={`${SIDEBAR_ROW} ${chat.pr ? 'pr-12' : ''} ${onArchive ? 'group-hover/row:pr-8' : ''}`}
      >
        {chat.icon ? (
          <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none">
            {chat.icon}
          </span>
        ) : (
          <DorkIcon size={14} state={iconState} label={iconLabel} />
        )}
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      </Link>
      {chat.pr && (
        <span
          data-pr={chat.pr.state}
          className={`pointer-events-none absolute top-1/2 right-2 z-20 -translate-y-1/2 text-xs tabular-nums ${onArchive ? 'group-hover/row:opacity-0' : ''} ${prStatus(chat.pr.state).className}`}
        >
          #{chat.pr.number}
        </span>
      )}
      {onArchive && (
        <Tip label="Archive">
          <button
            type="button"
            aria-label={`Archive ${chat.title}`}
            onClick={() => onArchive(chat.id)}
            className="absolute top-1/2 right-1 z-20 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-(--control-radius) text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(hover:none)]:hidden"
          >
            <ArchiveIcon aria-hidden className="size-3.5" />
          </button>
        </Tip>
      )}
    </div>
  )
  if (!onArchive) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <DropdownMenuItem onClick={() => onArchive(chat.id)}>
          <ArchiveIcon />
          Archive
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const { href } = router.buildLocation({ to, search: { dork: chat.id } })
            // `createHref` adds the history's own prefix (the `#` of hash routing).
            void navigator.clipboard.writeText(new URL(router.history.createHref(href), window.location.origin).href).then(() => toast('Link copied'))
          }}
        >
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
