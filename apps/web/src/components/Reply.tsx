import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, ReplyIcon, TextQuoteIcon, XIcon } from 'lucide-react'
import { Popover, PopoverContent } from '@dorks/ui/popover'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@dorks/ui/input-group'
import { quoteText, replyLabel, type Reply } from '../lib/reply'
import { Tip } from './Tip'

/** How the transcript starts a reply: into the composer (`onReply`), or sent straight from the box on a selection (`onSend`). */
export interface ReplyHandlers {
  /** Puts the reply in the composer's banner, with `draft` (what was typed in the box on a selection) added to its text. */
  onReply?: (reply: Reply, draft?: string) => void
  /** Sends a reply written in the box on the selection; resolving `false` (or throwing) keeps the box open with the draft. */
  onSend?: (reply: Reply, text: string) => void | Promise<unknown>
  /** The agent's name for the box's placeholder ("Reply to Claude"). */
  agent?: string
  /** Turns the image URL the chat shows back into the `dorks-image:<id>` the agent can load. */
  refOf?: (src: string) => string | undefined
}

export const ReplyContext = createContext<ReplyHandlers>({})
export const useReply = () => useContext(ReplyContext)

/** Marks an element whose selected text can be replied to (the agent's messages). */
export const REPLY_SOURCE = 'data-reply-source'
const HIGHLIGHT = 'dorks-reply'

type Target = { range: Range; text: string }

/**
 * Selecting text in the agent's messages opens a small box on the selection: the passage, quoted, and a field to answer it right
 * there (Enter sends). The quote button moves the passage and anything typed to the composer instead. The passage stays highlighted
 * (CSS Custom Highlight) while the box is open, since focusing the field clears the real selection.
 */
export function SelectionReply() {
  const { onReply, onSend, agent } = useReply()
  const [target, setTarget] = useState<Target>()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const enabled = !!(onReply || onSend)

  useEffect(() => {
    if (!enabled) return
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0) return
      // The selection settles after pointerup (a double click selects the word then).
      requestAnimationFrame(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || !selection.rangeCount) return
        const range = selection.getRangeAt(0)
        const within = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(`[${REPLY_SOURCE}]`)
        if (!within(range.startContainer) || !within(range.endContainer)) return
        const quoted = quoteText(selection.toString())
        if (!quoted) return
        setText('')
        setTarget({ range: range.cloneRange(), text: quoted })
      })
    }
    document.addEventListener('pointerup', onUp)
    return () => document.removeEventListener('pointerup', onUp)
  }, [enabled])

  useEffect(() => {
    const highlights = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (!target || !highlights || typeof Highlight === 'undefined') return
    highlights.set(HIGHLIGHT, new Highlight(target.range))
    return () => void highlights.delete(HIGHLIGHT)
  }, [target])

  if (!enabled || !target) return null
  const reply: Reply = { kind: 'text', text: target.text }
  const close = () => setTarget(undefined)
  const toComposer = () => {
    onReply?.(reply, text.trim() || undefined)
    close()
  }
  const send = async () => {
    if (!onSend || !text.trim() || sending) return
    setSending(true)
    try {
      if ((await onSend(reply, text)) === false) return
      window.getSelection()?.removeAllRanges()
      close()
    } catch {
      // The chat shows the error; the box stays open with the draft.
    } finally {
      setSending(false)
    }
  }
  // Anchored on the selection's first line, so a long passage does not push the box off screen.
  const anchor = { getBoundingClientRect: () => target.range.getClientRects()[0] ?? target.range.getBoundingClientRect() }
  return (
    <Popover open onOpenChange={(open) => { if (!open) close() }}>
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={6}
        initialFocus={inputRef}
        finalFocus={false}
        data-testid="selection-reply"
        className="w-80 gap-2 rounded-[10px] p-2 [--control-radius:6px]"
      >
        <blockquote className="line-clamp-2 border-l-2 border-foreground/15 pl-2 text-xs text-muted-foreground">{target.text}</blockquote>
        <form onSubmit={(e) => { e.preventDefault(); void send() }}>
          <InputGroup className="h-8 rounded-(--control-radius)">
            <InputGroupInput
              ref={inputRef}
              aria-label={`Reply to ${agent ?? 'the agent'}`}
              placeholder={`Reply to ${agent ?? 'the agent'}`}
              autoComplete="off"
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              className="text-sm"
            />
            <InputGroupAddon align="inline-end" className="gap-0.5 pr-1">
              {onReply && (
                <Tip label="Reply in composer">
                  <InputGroupButton size="icon-xs" variant="ghost" aria-label="Reply in composer" onClick={toComposer} className="rounded-[6px] text-muted-foreground hover:text-foreground">
                    <TextQuoteIcon />
                  </InputGroupButton>
                </Tip>
              )}
              {onSend && (
                <Tip label="Send reply">
                  <InputGroupButton type="submit" size="icon-xs" variant="default" aria-label="Send reply" disabled={!text.trim() || sending} className="rounded-[6px] bg-brand text-brand-foreground hover:bg-brand-hover disabled:bg-foreground/[0.08] disabled:text-foreground/35 disabled:opacity-100">
                    <ArrowUpIcon />
                  </InputGroupButton>
                </Tip>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** The reply as one quiet line: an image's thumbnail or the quoted text, cut to one line. */
function ReplyLine({ reply, className = '' }: { reply: Reply; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <ReplyIcon aria-hidden className="size-3.5 shrink-0" />
      {reply.kind === 'image' && reply.src && <img src={reply.src} alt="" className="size-5 shrink-0 rounded-[4px] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />}
      <span className="min-w-0 truncate">{reply.kind === 'text' ? `“${replyLabel(reply)}”` : replyLabel(reply)}</span>
    </span>
  )
}

/** The composer's banner: what the next message replies to, and an X to drop it. */
export function ReplyBanner({ reply, onClear }: { reply: Reply; onClear: () => void }) {
  return (
    <div data-testid="composer-reply" className="flex h-8 w-full min-w-0 items-center gap-1 rounded-[7px] bg-foreground/[0.04] pr-1 pl-2.5 text-[13px] text-muted-foreground">
      <ReplyLine reply={reply} className="flex-1" />
      <Tip label="Remove reply">
        <InputGroupButton size="icon-xs" variant="ghost" aria-label="Remove reply" onClick={onClear} className="rounded-[6px] shrink-0 text-muted-foreground hover:text-foreground [--control-radius:6px]">
          <XIcon />
        </InputGroupButton>
      </Tip>
    </div>
  )
}

/** Above a sent message: what it replied to. */
export function ReplyQuote({ reply }: { reply: Reply }) {
  return (
    <div data-testid="message-reply" title={reply.kind === 'text' ? reply.text : reply.alt} className="flex max-w-[85%] justify-end text-xs text-muted-foreground">
      <ReplyLine reply={reply} />
    </div>
  )
}
