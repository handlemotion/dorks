import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Block } from '@dorks/shared'
import { useMessageScroller } from '@dorks/ui/message-scroller'
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

/** How often, at most, the active row follows the scroll: often enough to read as live, rarely enough to cost nothing while flinging. */
const FOLLOW_MS = 100
/** An item showing less than this under the top edge does not count as on screen (the scroller's own peek of the previous message). */
const PEEK = 64

/** The first of `items` (in document order) for which `after` holds, by binary search: `after` is false, then true, down the list. */
function firstWhere(items: HTMLElement[], after: (el: HTMLElement) => boolean): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (after(items[mid])) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The message the reader is at: the first one on screen, or the last one on screen once the transcript is scrolled to its end. Found by
 * a binary search over the scroller's items (a few layout reads), at most every `FOLLOW_MS` while it scrolls, instead of observing
 * every item's visibility on every frame, which cost a long transcript most of each frame while scrolling fast.
 */
function useReadingAt(nav: RefObject<HTMLElement | null>, revision: unknown): string | undefined {
  const [at, setAt] = useState<string>()
  useEffect(() => {
    const viewport = nav.current?.parentElement?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = viewport?.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    if (!viewport || !content) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const measure = () => {
      timer = undefined
      last = performance.now()
      const items = [...content.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.messageId)
      if (!items.length) return setAt(undefined)
      const view = viewport.getBoundingClientRect()
      const atEnd = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2
      const i = atEnd ? firstWhere(items, (el) => el.getBoundingClientRect().top >= view.bottom) - 1 : firstWhere(items, (el) => el.getBoundingClientRect().bottom > view.top + PEEK)
      setAt(items[Math.min(Math.max(i, 0), items.length - 1)].dataset.messageId)
    }
    const onScroll = () => {
      if (timer === undefined) timer = setTimeout(measure, Math.max(0, FOLLOW_MS - (performance.now() - last)))
    }
    measure()
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
    }
  }, [nav, revision])
  return at
}

/** One row: a short tick, longer and darker when active or hovered. Redrawn only when one of those changes. */
const TocRow = memo(function TocRow({
  item,
  active,
  hovered,
  onHover,
  onLeave,
  onJump,
}: {
  item: TocItem
  active: boolean
  hovered: boolean
  onHover: (id: string, target: HTMLButtonElement) => void
  onLeave: (id: string) => void
  onJump: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid="chat-toc-row"
      data-message-id={item.id}
      data-active={active || undefined}
      aria-label={`Jump to message: ${item.preview}`}
      aria-current={active ? 'location' : undefined}
      onMouseEnter={(e) => onHover(item.id, e.currentTarget)}
      onFocus={(e) => onHover(item.id, e.currentTarget)}
      onBlur={() => onLeave(item.id)}
      onClick={() => onJump(item.id)}
      className="flex h-2.5 w-7 shrink-0 cursor-pointer items-center rounded-(--control-radius) px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className={
          active
            ? 'block h-[2px] w-4 rounded-full bg-foreground transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
            : hovered
              ? 'block h-[2px] w-3 rounded-full bg-foreground/45 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
              : 'block h-[2px] w-2.5 rounded-full bg-foreground/20 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none'
        }
      />
    </button>
  )
})

/**
 * Compact left-edge table of contents for user messages in the chat transcript.
 * Each row is a short horizontal tick; hovering or focusing a row shows a non-interactive preview card beside it,
 * and clicking the row itself scrolls the transcript to that message.
 */
export function ChatToc({ blocks, hidden }: { blocks: Block[]; hidden?: boolean }) {
  const { scrollToMessage } = useMessageScroller()
  const { items, ownerByMessageId } = useMemo(() => buildToc(blocks), [blocks])
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<{ id: string; top: number } | null>(null)
  const shown = !hidden && items.length >= 2
  const readingAt = useReadingAt(navRef, shown ? blocks : null)
  const activeId = (readingAt && ownerByMessageId.get(readingAt)) ?? items.at(-1)?.id

  // Stable, so a row redraws only when its own state changes.
  const handlers = useMemo(
    () => ({
      onHover: (id: string, target: HTMLButtonElement) => {
        const scrollTop = listRef.current?.scrollTop ?? 0
        setHovered({ id, top: target.offsetTop + target.offsetHeight / 2 - scrollTop })
      },
      onLeave: (id: string) => setHovered((cur) => (cur?.id === id ? null : cur)),
      onJump: (id: string) => scrollToMessage(id, { align: 'start', behavior: 'smooth' }),
    }),
    [scrollToMessage],
  )

  if (!shown) return null

  const hoveredItem = hovered ? items.find((item) => item.id === hovered.id) : undefined

  return (
    <nav
      ref={navRef}
      aria-label="Message index"
      data-testid="chat-toc"
      data-chat-toc
      className="pointer-events-auto absolute top-1/2 left-1 z-20 hidden max-h-[60%] -translate-y-1/2 flex-col sm:flex"
      onMouseLeave={() => setHovered(null)}
    >
      <div ref={listRef} onScroll={() => setHovered(null)} className="relative flex min-h-0 flex-col overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <TocRow key={item.id} item={item} active={item.id === activeId} hovered={hovered?.id === item.id} {...handlers} />
        ))}
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
