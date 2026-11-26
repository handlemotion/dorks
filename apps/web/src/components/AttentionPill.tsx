import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { Block } from '@dorks/shared'
import { MessageScrollerButton } from '@dorks/ui/message-scroller'
import { ATTENTION_COLOR } from './DorkIcon'

/**
 * What the session waits on the owner for, the oldest first: a pending request for the owner's computer or for secure input, a
 * submitted machine change, or a ship that failed while the server still follows it (the server's `needsAttentionOf`).
 */
export function attentionBlock(blocks: Block[]): Block | undefined {
  return blocks.find(
    (b) =>
      (b.kind === 'local' && b.status === 'pending') ||
      (b.kind === 'input' && b.status === 'pending') ||
      (b.kind === 'build' && b.approved === null) ||
      (b.kind === 'ship' && b.ship.status === 'failed' && b.ship.endedAt === undefined),
  )
}

const drawn = (el: Element) => el.getBoundingClientRect().height > 0

/**
 * The card drawn for a block (`data-block-id`, see `Waiting` in ChatBlock). A ship's card is drawn under the last ship of its group, or
 * pinned at the end, so a failed ship that is not the last one is found at the next drawn ship card.
 */
export function attentionElement(viewport: HTMLElement, id: string): HTMLElement | undefined {
  const all = [...viewport.querySelectorAll<HTMLElement>('[data-block-id]')]
  const at = all.findIndex((el) => el.dataset.blockId === id)
  if (at < 0) return undefined
  if (drawn(all[at])) return all[at]
  if (all[at].dataset.ship === undefined) return undefined
  return all.slice(at + 1).find((el) => el.dataset.ship !== undefined && drawn(el))
}

/** Scrolls the transcript so the card sits in the middle of the view. */
export function scrollToAttention(viewport: HTMLElement, el: HTMLElement) {
  const view = viewport.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  const top = viewport.scrollTop + box.top - view.top - Math.max(24, (viewport.clientHeight - box.height) / 2)
  viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

/**
 * The block the session waits on and a jump to its card. A card above the drawn window is drawn first (`reveal`), then scrolled to once
 * it is there.
 */
export function useAttention(viewport: RefObject<HTMLElement | null>, waiting: boolean, blocks: Block[], shown: Block[], reveal: (index: number) => void) {
  const target = useMemo(() => (waiting ? attentionBlock(blocks) : undefined), [waiting, blocks])
  const [seeking, setSeeking] = useState<string>()
  useEffect(() => {
    const root = viewport.current
    const el = seeking && root ? attentionElement(root, seeking) : undefined
    if (!root || !el) return
    setSeeking(undefined)
    scrollToAttention(root, el)
  }, [viewport, seeking, shown])
  const jump = (id: string) => {
    const root = viewport.current
    const el = root ? attentionElement(root, id) : undefined
    if (root && el) return scrollToAttention(root, el)
    reveal(blocks.findIndex((b) => b.id === id))
    setSeeking(id)
  }
  return { id: target?.id, jump }
}

/** Whether the card for `id` is out of view: not drawn yet (above the drawn window) or scrolled away. */
function useOffScreen(viewport: RefObject<HTMLElement | null>, id: string | undefined, revision: unknown): boolean {
  const [off, setOff] = useState(false)
  useEffect(() => {
    const root = viewport.current
    if (!id || !root) return setOff(false)
    const el = attentionElement(root, id)
    if (!el) return setOff(true)
    const observer = new IntersectionObserver((seen) => setOff(!seen.some((e) => e.isIntersecting)), { root, threshold: 0 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewport, id, revision])
  return off
}

/**
 * A small pill floating over the bottom of the transcript while the agent waits on the owner and what it asked for is out of view:
 * "Needs action", with the yellow of the sidebar's attention icon. Clicking it scrolls to the request. It draws the transcript's
 * scroll-to-end button too, lifted above the pill while both show.
 */
export function AttentionPill({
  viewport,
  id,
  revision,
  onJump,
}: {
  viewport: RefObject<HTMLElement | null>
  /** The block waited on (`attentionBlock`), none when nothing is. */
  id: string | undefined
  /** Changes when the drawn transcript does, so the card is looked for again. */
  revision: unknown
  onJump: (id: string) => void
}) {
  const shown = useOffScreen(viewport, id, revision)
  return (
    <>
      {/* Above the pill while both show. */}
      <MessageScrollerButton className={shown ? 'data-[direction=end]:bottom-13' : undefined} />
      <button
        type="button"
        data-testid="attention-pill"
        data-active={shown}
        aria-hidden={!shown}
        tabIndex={shown ? 0 : -1}
        onClick={() => id && onJump(id)}
        className="absolute bottom-4 left-1/2 z-20 inline-flex h-7 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-surface-line bg-surface px-3 text-xs font-medium text-foreground outline-none transition-[translate,scale,opacity] duration-200 hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 dark:border-border motion-reduce:transition-none"
      >
        <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: ATTENTION_COLOR }} />
        Needs action
      </button>
    </>
  )
}
