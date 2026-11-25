import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { CommentThread } from '@dorks/shared'
import { CommentRow, Initial, NewComment, authorName, type Names, type ThreadActions } from './CommentThread'
import type { Picked, Rect } from './useOverlay'

// Comments drawn over the preview, after omni's pins: a bubble at the top-right corner of each commented element (an avatar with a
// tail at its bottom-left), the passage of a text comment highlighted, and the thread in a panel beside the bubble. Everything here
// sits in a layer over the frame, in the frame's viewport coordinates (the overlay reports where each anchor is now).

const BUBBLE = 28
const PANEL = 320
const GAP = 6

/** Where something of `w` × `h` goes beside `box` inside `room`: below it if there is space, else above, kept inside. */
function beside(box: Rect, w: number, h: number, room: { width: number; height: number }): CSSProperties {
  const left = Math.max(GAP, Math.min(box.x, room.width - w - GAP))
  const below = box.y + box.height + GAP
  const top = below + h <= room.height - GAP || box.y - h - GAP < GAP ? Math.min(below, Math.max(GAP, room.height - h - GAP)) : box.y - h - GAP
  return { left, top, width: w }
}

const place = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.width, height: r.height })

function useDismiss(open: boolean, close: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (!t || panel.current?.contains(t) || t.closest('[data-comment-bubble], [role=menu], [data-slot=dropdown-menu-content]')) return
      latest.current()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && latest.current()
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return panel
}

export function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const o = new ResizeObserver(measure)
    o.observe(el)
    return () => o.disconnect()
  }, [ref])
  return size
}

export function PreviewMarks(props: {
  /** Open threads of this preview whose anchors are on the page now, with where they are. */
  threads: { thread: CommentThread; rects: Rect[] }[]
  names: Names
  actions: ThreadActions
  active: string | null
  setActive: (id: string | null) => void
  /** A passage or element just picked, waiting for its first comment. */
  draft: Picked | null
  onDraftSend: (body: string) => Promise<unknown>
  onDraftClose: () => void
  /** Drawn under the bubbles: the picker's hover box, the area being drawn. */
  children?: ReactNode
}) {
  const layer = useRef<HTMLDivElement>(null)
  const room = useSize(layer)
  const [hovered, setHovered] = useState<string | null>(null)
  const [replying, setReplying] = useState<string | null>(null)
  const open = props.threads.find((t) => t.thread.root.id === props.active)
  const panel = useDismiss(!!open, () => props.setActive(null))
  const draftPanel = useDismiss(!!props.draft, props.onDraftClose)
  // An element's bubble sits on its top-right corner, tail down; a passage's at the end of its last line.
  const spot = (rects: Rect[], text: boolean) => {
    const r = rects[rects.length - 1]!
    const at = text ? { x: r.x + r.width + 4, y: r.y + r.height / 2 - BUBBLE / 2 } : { x: r.x + r.width, y: rects[0]!.y - BUBBLE }
    return { x: Math.max(2, Math.min(at.x, room.width - BUBBLE - 2)), y: Math.max(2, Math.min(at.y, room.height - BUBBLE - 2)) }
  }
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 overflow-hidden">
      {props.children}
      {props.threads.map(({ thread, rects }) => {
        const id = thread.root.id
        const text = thread.root.anchor?.kind === 'text'
        const lit = hovered === id || props.active === id
        return (
          <div key={id}>
            {text
              ? rects.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label="Open comment"
                    tabIndex={-1}
                    data-comment-bubble
                    onClick={() => props.setActive(props.active === id ? null : id)}
                    onPointerEnter={() => setHovered(id)}
                    onPointerLeave={() => setHovered(null)}
                    style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                    className={`pointer-events-auto absolute cursor-pointer border-b-2 mix-blend-multiply dark:mix-blend-normal ${lit ? 'border-amber-500 bg-amber-300/45' : 'border-amber-500/60 bg-amber-300/25'}`}
                  />
                ))
              : lit && (
                  <div
                    aria-hidden
                    className="absolute rounded-[4px] border border-brand bg-brand/[0.08]"
                    style={{ left: rects[0]!.x, top: rects[0]!.y, width: rects[0]!.width, height: rects[0]!.height }}
                  />
                )}
            <Bubble
              thread={thread}
              names={props.names}
              at={spot(rects, text)}
              selected={props.active === id}
              onPress={() => props.setActive(props.active === id ? null : id)}
              onHover={(on) => setHovered(on ? id : null)}
            />
          </div>
        )
      })}
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Comment"
          className="pointer-events-auto absolute z-20 max-h-[min(28rem,70%)] overflow-y-auto rounded-[6px] border bg-background"
          style={beside({ ...spot(open.rects, open.thread.root.anchor?.kind === 'text'), width: BUBBLE, height: BUBBLE }, PANEL, 200, room)}
        >
          <ul>
            <CommentRow
              thread={open.thread}
              names={props.names}
              actions={props.actions}
              replying={replying === open.thread.root.id}
              onReplying={(on) => setReplying(on ? open.thread.root.id : null)}
              quote={
                open.thread.root.anchor?.kind === 'text' ? (
                  <p className="mb-3 line-clamp-2 border-s-2 border-amber-500 ps-2.5 text-sm text-muted-foreground">{open.thread.root.anchor.quote}</p>
                ) : undefined
              }
            />
          </ul>
          {replying !== open.thread.root.id && (
            <div className="border-t px-3 py-2">
              <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setReplying(open.thread.root.id)}>
                Reply
              </button>
            </div>
          )}
        </div>
      )}
      {props.draft && (
        <>
          {props.draft.anchor.kind === 'text' ? (
            <div aria-hidden className="absolute border-b-2 border-amber-500 bg-amber-300/40 mix-blend-multiply" style={place(props.draft.box)} />
          ) : (
            <div aria-hidden className="absolute rounded-[4px] border border-brand bg-brand/10" style={place(props.draft.box)} />
          )}
          <div ref={draftPanel} className="pointer-events-auto absolute z-20 rounded-[8px] border bg-background p-1" style={beside(props.draft.box, PANEL, 60, room)}>
            <NewComment onSend={props.onDraftSend} onClose={props.onDraftClose} />
          </div>
        </>
      )}
    </div>
  )
}

/** A thread's bubble: the first author's initial in a round bubble whose bottom-left corner points at the element; a count of replies. */
function Bubble(props: { thread: CommentThread; names: Names; at: { x: number; y: number }; selected: boolean; onPress: () => void; onHover: (on: boolean) => void }) {
  const { thread } = props
  const name = authorName(thread.root, props.names)
  const count = thread.replies.length
  return (
    <button
      type="button"
      data-comment-bubble
      aria-label={`Comment by ${name}: ${thread.root.body}`}
      aria-pressed={props.selected}
      onClick={props.onPress}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      style={{ left: props.at.x, top: props.at.y }}
      className={`pointer-events-auto absolute flex h-7 items-center gap-1 rounded-full rounded-bl-[3px] border bg-background p-0.5 pe-1 text-xs tabular-nums transition-none ${props.selected ? 'border-brand' : 'border-foreground/15 hover:border-foreground/30'}`}
    >
      <Initial name={name} className="size-[22px] rounded-full after:rounded-full *:rounded-full" />
      {count > 0 ? <span className="pe-0.5 text-muted-foreground">{count + 1}</span> : null}
    </button>
  )
}
