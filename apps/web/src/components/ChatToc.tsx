import { useMemo, useRef, useState } from 'react'
import type { Block } from '@dorks/shared'
import { useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility } from '@dorks/ui/message-scroller'
import { parseReply, replyLabel } from '../lib/reply'

/** Markdown images (`![alt](src)`), stripped when turning a user message into a short preview. */
const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

export interface TocItem {
  id: string
  preview: string
}

/** One compact preview line for a user message: its text, else its images or quoted reply. */
export function tocPreview(raw: string): string {
  const { reply, body } = parseReply(raw)
  const imageCount = [...body.matchAll(IMAGE)].length
  const text = body.replace(IMAGE, '').replace(/\s+/g, ' ').trim()
  if (text) return text
  if (imageCount > 0) return imageCount === 1 ? 'Image' : `${imageCount} images`
  if (reply) return replyLabel(reply)
  return 'Message'
}

/**
 * Extracts the user messages for the TOC and maps every scroller item id (user or agent entry) back to the user message that
 * started its turn, so scrolling through a long agent reply keeps its prompt active.
 */
function buildToc(blocks: Block[]): { items: TocItem[]; ownerByMessageId: Map<string, string> } {
  const items: TocItem[] = []
  const ownerByMessageId = new Map<string, string>()
  let currentUserId: string | undefined
  let inAgentRun = false

  for (const block of blocks) {
    if (block.kind === 'user') {
      currentUserId = block.id
      inAgentRun = false
      items.push({ id: block.id, preview: tocPreview(block.text) })
      ownerByMessageId.set(block.id, block.id)
    } else if (!inAgentRun) {
      inAgentRun = true
      if (currentUserId) ownerByMessageId.set(block.id, currentUserId)
    }
  }

  return { items, ownerByMessageId }
}

/**
 * Compact left-edge table of contents for user messages in the chat transcript.
 * Each row is a short horizontal tick; hovering or focusing a row shows a non-interactive preview card beside it,
 * and clicking the row itself scrolls the transcript to that message.
 */
export function ChatToc({ blocks, hidden }: { blocks: Block[]; hidden?: boolean }) {
  const { scrollToMessage } = useMessageScroller()
  const { visibleMessageIds } = useMessageScrollerVisibility()
  const scrollable = useMessageScrollerScrollable()
  const { items, ownerByMessageId } = useMemo(() => buildToc(blocks), [blocks])
  const listRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<{ id: string; top: number } | null>(null)

  const activeId = useMemo(() => {
    if (items.length === 0) return undefined
    const visibleOwners: string[] = []
    for (const id of visibleMessageIds) {
      const owner = ownerByMessageId.get(id)
      if (owner && !visibleOwners.includes(owner)) visibleOwners.push(owner)
    }
    if (visibleOwners.length > 0) {
      return !scrollable.end && scrollable.start ? visibleOwners[visibleOwners.length - 1] : visibleOwners[0]
    }
    return items[items.length - 1].id
  }, [items, ownerByMessageId, scrollable.end, scrollable.start, visibleMessageIds])

  if (hidden || items.length < 2) return null

  const hoveredItem = hovered ? items.find((item) => item.id === hovered.id) : undefined

  const showHover = (id: string, target: HTMLButtonElement) => {
    const scrollTop = listRef.current?.scrollTop ?? 0
    setHovered({ id, top: target.offsetTop + target.offsetHeight / 2 - scrollTop })
  }

  return (
    <nav
      aria-label="Message index"
      data-testid="chat-toc"
      className="pointer-events-auto absolute top-1/2 left-2 z-20 hidden max-h-[60%] -translate-y-1/2 flex-col sm:flex"
      onMouseLeave={() => setHovered(null)}
    >
      <div ref={listRef} onScroll={() => setHovered(null)} className="relative flex min-h-0 flex-col overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const isActive = item.id === activeId
          const isHovered = hovered?.id === item.id
          return (
            <button
              key={item.id}
              type="button"
              data-testid="chat-toc-row"
              data-message-id={item.id}
              data-active={isActive || undefined}
              aria-label={`Jump to message: ${item.preview}`}
              aria-current={isActive ? 'location' : undefined}
              onMouseEnter={(e) => showHover(item.id, e.currentTarget)}
              onFocus={(e) => showHover(item.id, e.currentTarget)}
              onBlur={() => setHovered((cur) => (cur?.id === item.id ? null : cur))}
              onClick={() => scrollToMessage(item.id, { align: 'start', behavior: 'smooth' })}
              className="flex h-2.5 w-7 shrink-0 cursor-pointer items-center rounded-(--control-radius) px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={
                  isHovered
                    ? 'block h-[2px] w-4 rounded-full bg-foreground transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
                    : isActive
                      ? 'block h-[2px] w-3.5 rounded-full bg-foreground/75 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
                      : 'block h-[2px] w-2.5 rounded-full bg-foreground/20 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
                }
              />
            </button>
          )
        })}
      </div>

      {hoveredItem && hovered && (
        <div
          role="tooltip"
          data-testid="chat-toc-preview"
          style={{ top: hovered.top }}
          className="pointer-events-none absolute left-full ml-1.5 w-max max-w-72 -translate-y-1/2 rounded-(--control-radius) border border-surface-line bg-surface px-2.5 py-1.5 text-sm leading-snug text-foreground dark:border-border"
        >
          <p className="line-clamp-3 break-words">{hoveredItem.preview}</p>
        </div>
      )}
    </nav>
  )
}
