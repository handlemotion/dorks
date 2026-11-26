import type { DorkMode, DorkState, SessionPr, SubscriptionView } from '@dorks/shared'
import { Link, useRouter, type RegisteredRouter } from '@tanstack/react-router'
import { move } from '@dnd-kit/helpers'
import { Accessibility, defaultPreset, KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { useRef, useState } from 'react'
import { ArchiveIcon, ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon } from 'lucide-react'
import { copyText, openContextMenu } from '../lib/contextMenu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@dorks/ui/hover-card'
import { useStoredOrder } from '../lib/storedOrder'
import { Tip } from './Tip'
import { DorkIcon, dorkIconState, type DorkIconState } from './DorkIcon'
import { SIDEBAR_ROW } from './sidebarChrome'
import { PrIcon, prStatus } from './PrStatus'
import { STAGE_ICON } from './ShipCard'
import { PersonAvatar, useTeamView } from './Teammates'
import type { Person } from '@dorks/client'

export type PrState = SubscriptionView['state']

/** One of a chat's pull requests in the sidebar; `state` is absent until the server has looked at it. */
export type ChatPr = Omit<SessionPr, 'repo' | 'url' | 'state'> & { url?: string; state?: PrState }

/** What the sidebar shows of a chat (a dork). */
export type Chat = {
  /** Dork id, passed through as the `dork` search param of the chat route. */
  id: string
  title: string
  /** `owner/name`; the sidebar's owner switcher filters by its owner. */
  repo?: string
  /** Something is moving in this chat. */
  working: boolean
  /** Lifecycle state of the dork, used to distinguish working (animated grey), awake (still grey) and asleep (grey outline). */
  state?: DorkState
  /** True when the dork is waiting on the owner (computer access, build approval, etc.). */
  attention?: boolean
  /** The agent finished a turn the owner has not opened yet: the icon is blue. */
  unread?: boolean
  /** The chat's pull requests, oldest first. */
  prs?: ChatPr[]
  /** A dork (coordinator) shows its emoji instead of the working icon (docs/crew.md). */
  icon?: string
  mode?: DorkMode
  /** A worker's coordinator: workers live inside their dork, not in the sidebar. */
  parentId?: string | null
  /** The teammate who started it, on a team server (docs/cloud.md). */
  createdBy?: Person
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
  limit,
}: {
  chats: Chat[]
  orderKey: string
  to?: ChatRoute
  /** The chat open in the page. */
  activeId?: string
  /** Archives a chat: the row's hover button and the Archive item of its right-click menu. Without it, neither shows. */
  onArchive?: (id: string) => void
  /** Rows shown before a Show more row (the open chat always shows). Without it, all of them. */
  limit?: number
}) {
  const [order, setOrder] = useStoredOrder(
    orderKey,
    chats.map((c) => c.id),
  )
  const [expanded, setExpanded] = useState(false)
  const byId = new Map(chats.map((c) => [c.id, c]))
  const hidden = limit !== undefined && !expanded ? order.slice(limit).filter((id) => id !== activeId).length : 0
  const shown = hidden ? order.filter((id, i) => i < limit! || id === activeId) : order
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
      {shown.map((id) => (
        <ChatItem key={id} chat={byId.get(id)!} index={order.indexOf(id)} to={to} active={id === activeId} onArchive={onArchive} />
      ))}
      {limit !== undefined && order.length > limit && (
        <button type="button" onClick={() => setExpanded(!expanded)} className={`${SIDEBAR_ROW} text-muted-foreground`}>
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          {expanded ? 'Show less' : `Show ${hidden} more`}
        </button>
      )}
    </DragDropProvider>
  )
}

const ICON_LABEL: Record<DorkIconState, string> = { attention: 'Needs attention', working: 'Working…', unread: 'Unread', awake: 'Awake', error: 'Error', asleep: 'Asleep' }

/**
 * A chat row. The leading DorkIcon (flat colours, no gradients) animates in grey while the chat is working, is blue while a finished turn is unread, yellow
 * while the dork waits on the owner, still grey when awake and a grey outline when asleep. The right edge shows the chat's pull
 * requests (`PrBadge`) and a spinner while a merge is shipping; hovering them lists the PRs and the checks still running. The row is
 * active (`data-active`, `aria-current`) while its chat is the one in the URL. With `onArchive`, hovering the row shows an archive
 * button at its edge (the PRs move left of it). A right click opens the row's menu (natively in the desktop app): Open, Copy link and,
 * with `onArchive`, Archive.
 */
function ChatItem({ chat, index, to, active, onArchive }: { chat: Chat; index: number; to: ChatRoute; active: boolean; onArchive?: (id: string) => void }) {
  // `data` feeds announcements; the link is the handle so interactive-element filtering allows row drags.
  const { ref, handleRef, isDragging } = useSortable({ id: chat.id, index, data: chat })
  const router = useRouter()
  const iconState = dorkIconState(chat.state, { working: chat.working, attention: chat.attention, unread: chat.unread })
  const iconLabel = ICON_LABEL[iconState]
  const { team, isSelf } = useTeamView()
  // Someone else started it (a teammate, docs/cloud.md): their initials end the title.
  const starter = team && chat.createdBy && !isSelf(chat.createdBy.id) ? chat.createdBy : undefined
  const prs = chat.prs ?? []
  const shipping = prs.some((p) => p.ship?.status === 'watching')
  // Room for the PRs (and the spinner) at the right edge, and for the archive button beside them on hover. Literal, for Tailwind.
  const pad = !prs.length
    ? onArchive
      ? 'group-hover/row:pr-8'
      : ''
    : shipping
      ? onArchive
        ? 'pr-16 group-hover/row:pr-[5.5rem]'
        : 'pr-16'
      : onArchive
        ? 'pr-12 group-hover/row:pr-[4.5rem]'
        : 'pr-12'
  const link = () => {
    const { href } = router.buildLocation({ to, search: { dork: chat.id } })
    // `createHref` adds the history's own prefix (the `#` of hash routing).
    return new URL(router.history.createHref(href), window.location.origin).href
  }
  return (
    <div
      ref={ref}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Open', onSelect: () => void router.navigate({ to, search: { dork: chat.id } }) },
          { label: 'Copy link', onSelect: () => copyText(link(), 'Link copied') },
          ...(onArchive ? (['separator', { label: 'Archive', onSelect: () => onArchive(chat.id) }] as const) : []),
        ])
      }
      data-chat-id={chat.id}
      data-dragging={isDragging || undefined}
      className="group/row relative flex min-w-0 data-[dragging]:z-30 data-[dragging]:opacity-60"
    >
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
        title={starter ? `${chat.title} · started by ${starter.name}` : chat.title}
        className={`${SIDEBAR_ROW} ${pad}`}
      >
        {chat.icon ? (
          <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none">
            {chat.icon}
          </span>
        ) : (
          <DorkIcon size={14} state={iconState} label={iconLabel} nerd={chat.mode === 'nerd'} />
        )}
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        {starter && <PersonAvatar person={starter} size="xs" />}
      </Link>
      {prs.length > 0 && <PrBadge prs={prs} shipping={shipping} className={onArchive ? 'group-hover/row:right-8' : ''} onClick={() => void router.navigate({ to, search: { dork: chat.id } })} />}
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
}

/** The PR whose colour stands for the chat: an open one first (there is still work in flight), else the newest. */
export function leadPr(prs: ChatPr[]): ChatPr | undefined {
  return prs.findLast((p) => p.state === 'open') ?? prs.at(-1)
}

/**
 * A chat's pull requests at its row's right edge: `#227` for one, `3` and the PR icon for several, coloured by `leadPr` (open
 * green, merged violet, closed red), then a spinner while a merge is shipping. Hovering lists every PR with its state, and under a
 * shipping one the checks its merge set off.
 */
function PrBadge({ prs, shipping, className, onClick }: { prs: ChatPr[]; shipping: boolean; className: string; onClick: () => void }) {
  const lead = leadPr(prs)
  const status = prStatus(lead?.state)
  const ref = useRef<HTMLSpanElement>(null)
  // Beside the sidebar, not over the row: from the badge past the row's end (and the archive button there) and the sidebar's 6px gutter.
  const pastRow = () => {
    const badge = ref.current?.getBoundingClientRect()
    const row = ref.current?.closest('[data-chat-id]')?.getBoundingClientRect()
    return badge && row ? row.right - badge.right + 14 : 10
  }
  const label = `${prs.length === 1 ? `Pull request #${prs[0].number}` : `${prs.length} pull requests`}${shipping ? ', shipping' : ''}`
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={100}
        render={
          <span
            ref={ref}
            role="button"
            aria-label={label}
            data-pr={lead?.state}
            data-testid="chat-prs"
            onClick={onClick}
            className={`absolute top-1/2 right-2 z-20 flex h-6 -translate-y-1/2 cursor-pointer items-center gap-1.5 text-xs tabular-nums ${className}`}
          />
        }
      >
        {prs.length === 1 ? (
          <span className={status.className}>#{prs[0].number}</span>
        ) : (
          <span className={`flex items-center gap-0.5 ${status.className}`}>
            {prs.length}
            <status.Icon aria-hidden className="size-3" />
          </span>
        )}
        {shipping && <LoaderCircleIcon aria-hidden className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" />}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        sideOffset={pastRow}
        data-testid="chat-prs-card"
        className="w-max max-w-80 min-w-56 rounded-(--control-radius) border border-surface-line bg-surface p-1 text-sm text-foreground ring-0 dark:border-border"
      >
        <ul className="flex min-w-0 flex-col">
          {prs.toReversed().map((pr) => (
            <li key={pr.url ?? pr.number} className="flex min-w-0 flex-col">
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="flex h-7 min-w-0 items-center gap-2 rounded-[4px] px-2 outline-none hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-ring"
              >
                <PrIcon state={pr.state} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{pr.title ?? `Pull request #${pr.number}`}</span>
                <span className="shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">#{pr.number}</span>
              </a>
              {pr.ship?.status === 'watching' &&
                pr.ship.stages.map((stage, i) => {
                  const look = STAGE_ICON[stage.state]
                  return (
                    <a
                      key={i}
                      href={stage.url}
                      target="_blank"
                      rel="noreferrer"
                      data-stage={stage.state}
                      className="flex h-6 min-w-0 items-center gap-2 rounded-[4px] pr-2 pl-[30px] text-xs text-muted-foreground outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <look.icon aria-label={look.label} className={`size-3 shrink-0 ${look.className}`} />
                      <span className="min-w-0 truncate">{stage.name}</span>
                    </a>
                  )
                })}
              {pr.ship?.status === 'watching' && !pr.ship.stages.length && (
                <p className="flex h-6 min-w-0 items-center gap-2 pr-2 pl-[30px] text-xs text-muted-foreground">
                  <LoaderCircleIcon aria-hidden className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
                  Waiting for checks to start
                </p>
              )}
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  )
}
