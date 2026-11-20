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

/** Whether a node is inside one of the agent's messages, whose text can be replied to. */
const within = (node: Node) => !!(node instanceof Element ? node : node.parentElement)?.closest(`[${REPLY_SOURCE}]`)

/** ⌘ on Apple platforms, Ctrl elsewhere: the key that turns Enter into send. */
const SEND_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/**
 * Selecting text in the agent's messages offers a small Reply button on the selection; nothing takes focus, so the selection stays
 * the browser's own and can still be changed. Pressing Reply opens a compact box there: the passage, quoted on one line, and a field
 * for the answer. Enter (or the arrow) attaches the passage to the composer as a reply, with anything typed as the composer's text;
 * ⌘ Enter (Ctrl Enter) sends it right away. The arrow's tooltip says so. The passage stays highlighted (CSS Custom Highlight) while
 * the box is open, since focusing the field clears the real selection.
 */
export function SelectionReply() {
  const { onReply, onSend, agent } = useReply()
  const [target, setTarget] = useState<Target>()
  // false: only the Reply button shows; true: the box with the field.
  const [expanded, setExpanded] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const enabled = !!onReply

  useEffect(() => {
    if (!enabled) return
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0) return
      // A press on the button or in the box is not a new selection.
      if (event.target instanceof Element && event.target.closest('[data-selection-reply]')) return
      // The selection settles after pointerup (a double click selects the word then).
      requestAnimationFrame(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || !selection.rangeCount) return
        const range = selection.getRangeAt(0)
        if (!within(range.startContainer) || !within(range.endContainer)) return
        const quoted = quoteText(selection.toString())
        if (!quoted) return
        setText('')
        setExpanded(false)
        setTarget({ range: range.cloneRange(), text: quoted })
      })
    }
    document.addEventListener('pointerup', onUp)
    return () => document.removeEventListener('pointerup', onUp)
  }, [enabled])

  // While only the button shows, it follows the real selection: adjusted (Shift+Arrow), it quotes the new passage; cleared (a click
  // elsewhere, Escape) or moved out of the agent's messages, the button goes too.
  useEffect(() => {
    if (!target || expanded) return
    const onChange = () => {
      const selection = window.getSelection()
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined
      const quoted = range && within(range.startContainer) && within(range.endContainer) ? quoteText(selection!.toString()) : undefined
      setTarget(range && quoted ? { range: range.cloneRange(), text: quoted } : undefined)
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [target, expanded])

  // The box replaces the button in the same open popover, so its field is focused here rather than by the popover's initialFocus.
  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  useEffect(() => {
    const highlights = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (!target || !expanded || !highlights || typeof Highlight === 'undefined') return
    highlights.set(HIGHLIGHT, new Highlight(target.range))
    return () => void highlights.delete(HIGHLIGHT)
  }, [target, expanded])

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
  if (!expanded)
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
          sideOffset={8}
          initialFocus={false}
          finalFocus={false}
          data-testid="selection-reply-button"
          data-selection-reply=""
          className="w-auto gap-0 rounded-[8px] p-0.5 [--control-radius:6px]"
        >
          <button
            type="button"
            // Keeps the selection: a press on a button would otherwise clear it before the click.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setExpanded(true)}
            className="flex h-6 cursor-pointer items-center gap-1 rounded-(--control-radius) px-1.5 text-xs text-foreground outline-none hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]"
          >
            <ReplyIcon aria-hidden className="size-3 text-muted-foreground" />
            Reply
          </button>
        </PopoverContent>
      </Popover>
    )
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
        data-selection-reply=""
        className="w-72 gap-1.5 rounded-[10px] p-1.5 [--control-radius:6px]"
      >
        <blockquote className="mx-1 mt-0.5 truncate border-l-2 border-foreground/15 pl-2 text-xs leading-4 text-muted-foreground">{target.text}</blockquote>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            attach()
          }}
        >
          {/* Fill only: the field is always focused in the box, so the focus border and ring would just frame it twice. */}
          <InputGroup className="h-8 rounded-(--control-radius) has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0">
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
            {/* Quiet, like the composer's +: it attaches by default, so it is not the blue send. 4px around it in the 32px field. */}
            <InputGroupAddon align="inline-end" className="pr-[3px] has-[>button]:mr-0">
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
