import { Accessibility, defaultPreset, KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { move } from '@dnd-kit/helpers'
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { useStoredOrder } from '../../lib/storedOrder'
import { ChatLink, type Chat, type ChatRoute } from './ChatLink'

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
 * One provider per list, so a chat cannot be dragged into another list: which list it is in is derived from its data.
 */
export function SortableChatList({ chats, orderKey, to }: { chats: Chat[]; orderKey: string; to?: ChatRoute }) {
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
        <SortableChatLink key={id} chat={byId.get(id)!} index={index} to={to} />
      ))}
    </DragDropProvider>
  )
}

function SortableChatLink({ chat, index, to }: { chat: Chat; index: number; to?: ChatRoute }) {
  // `data` feeds the announcements above.
  const { ref, isDragging } = useSortable({ id: chat.id, index, data: chat })
  return <ChatLink {...chat} to={to} ref={ref} dragging={isDragging} />
}
