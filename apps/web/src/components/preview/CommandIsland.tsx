import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpIcon, GlobeIcon, ImageIcon, MessageSquareIcon, SquareMousePointerIcon, XIcon } from 'lucide-react'
import { anchorLine, type CommentThread } from '@dorks/shared'
import { Button } from '@dorks/ui/button'
import { Tip } from '../Tip'

// The command island under a running preview: a small message box for the agent, after the reference's "Ask AI" box. What the owner
// picked in the page (an element, a captured area) and what they mention with @ (a comment thread, another preview) ride along as
// chips above the text, and go out with it as context.

export type Chip =
  | { kind: 'element'; key: string; label: string; snippet: string; path: string }
  | { kind: 'image'; key: string; label: string; dataUrl: string; path: string }
  | { kind: 'comment'; key: string; label: string; thread: CommentThread }
  | { kind: 'preview'; key: string; label: string; url: string; port?: number }

type Option = { chip: Chip; title: string; meta: string; group: 'Comments' | 'Previews' }

/** The word being typed after an @, if the caret is in one. */
function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return m ? { query: m[2]!, start: caret - m[2]!.length - 1 } : null
}

/** `text` with the part matching `query` marked, as in the reference. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-amber-300/50 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  )
}

const CHIP_ICON: Record<Chip['kind'], ReactNode> = {
  element: <SquareMousePointerIcon />,
  image: <ImageIcon />,
  comment: <MessageSquareIcon />,
  preview: <GlobeIcon />,
}

export function CommandIsland(props: {
  chips: Chip[]
  onRemoveChip: (key: string) => void
  onAddChip: (chip: Chip) => void
  threads: CommentThread[]
  previews: { name: string; url: string; port?: number }[]
  onSend: (text: string) => Promise<unknown>
  onClose: () => void
  agent: string
}) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  useLayoutEffect(() => field.current?.focus(), [])

  const mention = mentionAt(text, caret)
  const options = useMemo<Option[]>(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const all: Option[] = [
      ...props.threads.map((t): Option => ({
        group: 'Comments',
        title: t.root.body.split('\n')[0]!,
        meta: [t.root.anchor ? anchorLine(t.root.anchor).replace(/^on /, '') : '', t.root.resolvedAt ? 'resolved' : ''].filter(Boolean).join(' · '),
        chip: { kind: 'comment', key: `comment:${t.root.id}`, label: t.root.body.split('\n')[0]!.slice(0, 40), thread: t },
      })),
      ...props.previews.map((p): Option => ({
        group: 'Previews',
        title: p.name,
        meta: p.port ? `:${p.port}` : p.url,
        chip: { kind: 'preview', key: `preview:${p.url}`, label: p.name, url: p.url, ...(p.port ? { port: p.port } : {}) },
      })),
    ]
    return all.filter((o) => !props.chips.some((c) => c.key === o.chip.key) && (!q || o.title.toLowerCase().includes(q) || o.meta.toLowerCase().includes(q))).slice(0, 12)
  }, [mention?.query, props.threads, props.previews, props.chips]) // eslint-disable-line react-hooks/exhaustive-deps
  const showing = !!mention && dismissed !== mention.start && options.length > 0
  useEffect(() => setSelected(0), [mention?.query])

  const choose = (o: Option) => {
    if (!mention) return
    props.onAddChip(o.chip)
    const next = text.slice(0, mention.start) + text.slice(caret)
    setText(next)
    setCaret(mention.start)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(mention.start, mention.start)
    })
  }

  const canSend = (!!text.trim() || props.chips.length > 0) && !sending
  const send = () => {
    if (!canSend) return
    setSending(true)
    setError('')
    props
      .onSend(text.trim())
      .then(() => setText(''))
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : 'It was not sent.'))
      .finally(() => setSending(false))
  }

  const groups = (['Comments', 'Previews'] as const).map((g) => ({ g, items: options.filter((o) => o.group === g) })).filter((x) => x.items.length)
  return (
    <div className="relative w-full">
      {showing && (
        <div role="listbox" aria-label="Mention" className="absolute inset-x-0 bottom-full mb-1.5 max-h-72 overflow-y-auto rounded-[8px] border bg-background py-1">
          {groups.map(({ g, items }, gi) => (
            <div key={g} className={gi ? 'mt-1 border-t pt-1' : ''}>
              <p className="px-3 pt-1.5 pb-1 text-xs text-muted-foreground">{g}</p>
              {items.map((o) => {
                const index = options.indexOf(o)
                return (
                  <button
                    key={o.chip.key}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    onPointerDown={(e) => e.preventDefault()}
                    onPointerEnter={() => setSelected(index)}
                    onClick={() => choose(o)}
                    className="mx-1 flex w-[calc(100%-8px)] items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-none aria-selected:bg-foreground/[0.05] [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                  >
                    {CHIP_ICON[o.chip.kind]}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        <Marked text={o.title} query={mention!.query} />
                      </span>
                      {o.meta && <span className="block truncate text-xs text-muted-foreground">{o.meta}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-1.5 rounded-[6px] bg-background px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-hidden rounded-[8px] border bg-background focus-within:border-ring/70">
        {props.chips.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b bg-foreground/[0.03] p-1.5">
            {props.chips.map((c) => (
              <span
                key={c.key}
                className="flex h-6 max-w-full items-center gap-1 rounded-[6px] bg-background ps-1.5 text-xs text-foreground [&>svg]:size-3 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
              >
                {c.kind === 'image' ? <img src={c.dataUrl} alt="" className="size-4 rounded-[3px] object-cover" /> : CHIP_ICON[c.kind]}
                <span className="min-w-0 truncate">{c.label}</span>
                <Tip label="Remove">
                  <button
                    type="button"
                    aria-label={`Remove ${c.label}`}
                    onClick={() => props.onRemoveChip(c.key)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </Tip>
              </span>
            ))}
          </div>
        )}
        <div className="relative flex items-end">
          <textarea
            ref={field}
            aria-label={`Message ${props.agent}`}
            placeholder={`Ask ${props.agent} about this page, @ to mention`}
            rows={1}
            value={text}
            aria-expanded={showing}
            aria-haspopup="listbox"
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              setDismissed(null)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (showing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSelected((s) => (s + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(options[selected]!)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDismissed(mention!.start)
                  return
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                props.onClose()
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            className="field-sizing-content max-h-40 min-h-0 flex-1 resize-none bg-transparent py-2.5 ps-3 pe-11 text-sm/5 outline-none placeholder:text-muted-foreground"
          />
          <div className="absolute right-1.5 bottom-1.5">
            <Tip label="Send ↵">
              <Button size="icon-sm" aria-label="Send" disabled={!canSend} onClick={send} className="size-7 rounded-[6px] bg-brand text-brand-foreground hover:bg-brand-hover">
                <ArrowUpIcon />
              </Button>
            </Tip>
          </div>
        </div>
      </div>
    </div>
  )
}
