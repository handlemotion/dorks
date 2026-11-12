import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, ReplyIcon, XIcon } from 'lucide-react'
import { Popover, PopoverContent } from '@dorks/ui/popover'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@dorks/ui/input-group'
import { quoteText, replyLabel, type Reply } from '../lib/reply'
import { Tip } from './Tip'

/** How the transcript starts a reply: attached to the composer (`onReply`, the default), or sent from a selection's box (`onSend`). */
export interface ReplyHandlers {
  /** Puts the reply in the composer's banner, with `draft` (what was typed in the box on a selection) added to its text. */
  onReply?: (reply: Reply, draft?: string) => void
  /** Sends a reply written in a selection's box (⌘ Enter); resolving `false` or throwing keeps the box open with the draft. */
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

/** ⌘ on Apple platforms, Ctrl elsewhere: the key that turns Enter into send. */
const SEND_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/**
 * Selecting text in the agent's messages opens a small box on the selection: the passage, quoted, and a field for the answer.
 * Enter (or the arrow) attaches the passage to the composer as a reply, with anything typed as the composer's text; ⌘ Enter
 * (Ctrl Enter) sends it right away. The arrow's tooltip says so. The passage stays highlighted (CSS Custom Highlight) while the box
 * is open, since focusing the field clears the real selection.
 */
export function SelectionReply() {
  const { onReply, onSend, agent } = useReply()
  const [target, setTarget] = useState<Target>()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const enabled = !!onReply

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
  const attach = () => {
    onReply?.(reply, text.trim() || undefined)
    window.getSelection()?.removeAllRanges()
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
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={6}
        initialFocus={inputRef}
        finalFocus={false}
        data-testid="selection-reply"
        // Portaled outside the app frame, so it sets the main app's grey focus ring itself (glass.css) instead of the brand blue.
        className="w-80 gap-3 rounded-[10px] p-3 [--control-radius:6px] [--ring:oklch(0.85_0_0)] dark:[--ring:oklch(1_0_0/28%)]"
      >
        <blockquote className="line-clamp-3 border-l-2 border-foreground/15 px-2.5 py-0.5 text-sm leading-5 text-muted-foreground">{target.text}</blockquote>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            attach()
          }}
        >
          <InputGroup className="h-9 rounded-(--control-radius)">
            <InputGroupInput
              ref={inputRef}
              aria-label={`Reply to ${agent ?? 'the agent'}`}
              placeholder={`Reply to ${agent ?? 'the agent'}`}
              autoComplete="off"
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !onSend) return
                e.preventDefault()
                void send()
              }}
              className="text-sm"
            />
            {/* Quiet, like the composer's +: it attaches by default, so it is not the blue send. 6px around it in the 36px field. */}
            <InputGroupAddon align="inline-end" className="pr-[5px] has-[>button]:mr-0">
              <Tip side="top" label={onSend ? `Enter to attach, ${SEND_KEY} Enter to send` : 'Enter to attach'}>
                <InputGroupButton type="submit" size="icon-xs" variant="ghost" aria-label="Attach to composer" disabled={sending} className="rounded-[6px] text-muted-foreground hover:text-foreground">
                  <ArrowUpIcon />
                </InputGroupButton>
              </Tip>
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
      {reply.kind === 'image' && reply.src && (
        <img src={reply.src} alt="" className="size-5 shrink-0 rounded-[4px] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />
      )}
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
        <InputGroupButton
          size="icon-xs"
          variant="ghost"
          aria-label="Remove reply"
          onClick={onClear}
          className="rounded-[6px] shrink-0 text-muted-foreground hover:text-foreground [--control-radius:6px]"
        >
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
