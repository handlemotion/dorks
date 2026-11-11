import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { EMOJI_GROUPS } from './emojis'
import { AddEmojiIcon, AloudIcon, BadIcon, CopiedIcon, CopyIcon, ForkIcon, GoodIcon, MoreIcon, ReplyIcon, ReportIcon, SearchIcon, SmileIcon } from './icons'

/**
 * The action row under an agent's answer, ported from aicss's Message Actions (https://www.aicss.dev/components/message-actions):
 * same behaviour, geometry and motion, its CSS module rewritten as Tailwind on the app's tokens. Where the app's rules differ, the
 * rules win: opaque tooltip with no blur, 12px text, 6px controls, popovers in the dropdown menu's hairline and its one shadow.
 */

/** The dropdown menu's soft shadow (packages/ui dropdown-menu.tsx), the one the app allows, on the row's popovers. */
const MENU_SURFACE = 'rounded-[10px] border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_-1px_rgb(0_0_0/0.04),0_6px_10px_-6px_rgb(0_0_0/0.07)]' // ui-rules: allow

const BUTTON =
  'relative inline-flex size-5 cursor-pointer items-center justify-center rounded-(--control-radius) border-0 bg-transparent p-0 text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] focus-visible:text-foreground data-[on=true]:bg-foreground/[0.07] data-[on=true]:text-foreground'

/** Each glyph names its own transform origin (aicss's default is 50% 82%). */
const GLYPH = 'block size-3'

const HOVER_FILL = 'hover:bg-foreground/[0.04] data-[on=true]:bg-foreground/[0.04]'

/** Joins class names; no merging, so no two of them may set the same property. */
const cn = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

type CueApi = { aim: (anchor: HTMLElement, label: string) => void; hide: () => void }

const CueContext = createContext<CueApi | null>(null)

/** A label for the control inside it, shown in the row's one tooltip, which glides between controls instead of reopening. */
function Cue({ label, children, quiet = false }: { label: string; children: ReactNode; quiet?: boolean }) {
  const cue = useContext(CueContext)
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !cue) return
    const hot = node.matches(':hover') || node.contains(document.activeElement)
    if (!hot) return
    if (quiet) cue.hide()
    else cue.aim(node, label)
  }, [cue, label, quiet])

  return (
    <span
      ref={ref}
      className="inline-flex"
      onMouseEnter={(event) => {
        if (!quiet) cue?.aim(event.currentTarget, label)
      }}
      onFocus={(event) => {
        if (!quiet) cue?.aim(event.currentTarget, label)
      }}
    >
      {children}
    </span>
  )
}

function RowCues({ children }: { children: ReactNode }) {
  const tipId = useId()
  const bubbleRef = useRef<HTMLDivElement>(null)
  const gaugeRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const labelRef = useRef('')
  const openRef = useRef(false)
  const describedRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')

  useEffect(() => setMounted(true), [])

  const write = (bubble: HTMLDivElement, x: number, y: number, width: number) => {
    bubble.style.setProperty('--cue-x', `${x}px`)
    bubble.style.setProperty('--cue-y', `${y}px`)
    bubble.style.setProperty('--cue-w', `${width}px`)
  }

  const measure = (anchor: HTMLElement, next: string) => {
    const bubble = bubbleRef.current
    const gauge = gaugeRef.current
    if (!bubble || !gauge) return null
    gauge.textContent = next
    const host = (anchor.querySelector('button, time') as HTMLElement | null) ?? anchor
    const rect = host.getBoundingClientRect()
    const width = Math.ceil(gauge.offsetWidth + 10)
    const height = Math.ceil(gauge.offsetHeight + 8)
    return { host, x: Math.round(rect.left + rect.width / 2 - width / 2), y: Math.round(rect.top - height - 6), width }
  }

  const place = useCallback(
    (anchor: HTMLElement, next: string, reveal: boolean) => {
      const bubble = bubbleRef.current
      const spot = measure(anchor, next)
      if (!bubble || !spot) return
      if (reveal && !openRef.current) {
        // Arriving: jump to the spot without gliding, then fade in.
        bubble.dataset.hold = 'true'
        write(bubble, spot.x, spot.y, spot.width)
        void bubble.offsetWidth
        delete bubble.dataset.hold
        openRef.current = true
        setOpen(true)
      } else if (openRef.current) {
        write(bubble, spot.x, spot.y, spot.width)
      }
      if (describedRef.current && describedRef.current !== spot.host) describedRef.current.removeAttribute('aria-describedby')
      spot.host.setAttribute('aria-describedby', tipId)
      describedRef.current = spot.host
      setLabel((current) => (current === next ? current : next))
    },
    [tipId],
  )

  const aim = useCallback(
    (anchor: HTMLElement, next: string) => {
      anchorRef.current = anchor
      labelRef.current = next
      place(anchor, next, true)
    },
    [place],
  )

  const hide = useCallback(() => {
    openRef.current = false
    anchorRef.current = null
    describedRef.current?.removeAttribute('aria-describedby')
    describedRef.current = null
    setOpen(false)
  }, [])

  useIsoLayoutEffect(() => {
    if (!open) return
    const follow = () => {
      const anchor = anchorRef.current
      const bubble = bubbleRef.current
      if (!anchor || !bubble || !openRef.current) return
      const spot = measure(anchor, labelRef.current)
      if (!spot) return
      bubble.dataset.hold = 'true'
      write(bubble, spot.x, spot.y, spot.width)
      void bubble.offsetWidth
      delete bubble.dataset.hold
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  const api = useMemo<CueApi>(() => ({ aim, hide }), [aim, hide])

  return (
    <CueContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <>
              <span ref={gaugeRef} className="pointer-events-none invisible fixed top-0 left-0 text-xs leading-none font-medium whitespace-nowrap" aria-hidden="true" />
              <div
                ref={bubbleRef}
                id={tipId}
                role="tooltip"
                data-up={open ? 'true' : undefined}
                aria-hidden={open ? undefined : true}
                className={cn(
                  'pointer-events-none fixed top-0 left-0 z-[1000] box-border flex w-(--cue-w,max-content) items-center justify-center overflow-hidden whitespace-nowrap',
                  'rounded-(--control-radius) bg-foreground px-[5px] py-1 text-xs leading-none font-medium text-background',
                  '[translate:var(--cue-x,0px)_var(--cue-y,0px)] [transform:translateY(1px)] opacity-0',
                  '[transition:opacity_50ms_ease,transform_50ms_ease,translate_160ms_cubic-bezier(0.22,1,0.36,1),width_160ms_cubic-bezier(0.22,1,0.36,1)]',
                  'data-[up=true]:[transform:none] data-[up=true]:opacity-100',
                  'data-[up=true]:[transition:opacity_150ms_ease_80ms,transform_150ms_ease_80ms,translate_160ms_cubic-bezier(0.22,1,0.36,1),width_160ms_cubic-bezier(0.22,1,0.36,1)]',
                  'data-[hold=true]:transition-none! motion-reduce:transition-none!',
                )}
              >
                {label}
              </div>
            </>,
            document.body,
          )
        : null}
    </CueContext.Provider>
  )
}

function CueRoot({ rootRef, children }: { rootRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const cue = useContext(CueContext)
  return (
    <div
      ref={rootRef}
      data-testid="message-actions"
      className="group/actions relative inline-flex items-center gap-0.5"
      onMouseLeave={() => cue?.hide()}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        cue?.hide()
      }}
    >
      {children}
    </div>
  )
}

const REACTIONS = ['👍', '❤️', '😄', '🎉', '🤔', '👀'] as const

type Vote = 'up' | 'down' | null

const ROLL_MS = 400

function elapsedMinutes(date: Date, now: number) {
  return Math.max(0, Math.round((now - date.getTime()) / 60000))
}

function formatAgo(date: Date, now = Date.now()) {
  const minutes = elapsedMinutes(date, now)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatAbsolute(date: Date) {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The minutes in "3m ago", each changed digit rolling up (or down) to its next value. */
function MinuteRoll({ value }: { value: string }) {
  const prevRef = useRef(value)
  const [oldVal, setOldVal] = useState(value)
  const [newVal, setNewVal] = useState(value)
  const [rolling, setRolling] = useState(false)
  const [shifted, setShifted] = useState(false)
  const [dir, setDir] = useState<'up' | 'down'>('up')

  useEffect(() => {
    if (prevRef.current === value) return
    const from = prevRef.current
    prevRef.current = value
    const fromN = parseInt(from, 10)
    const toN = parseInt(value, 10)
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? 'down' : 'up')
    setOldVal(from)
    setNewVal(value)
    setRolling(true)
    setShifted(false)

    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true))
    })
    const done = window.setTimeout(() => {
      setRolling(false)
      setOldVal(value)
      setShifted(false)
    }, ROLL_MS)

    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.clearTimeout(done)
    }
  }, [value])

  const chars = rolling ? newVal : oldVal

  return (
    <span className="inline-flex">
      {Array.from({ length: chars.length }, (_, i) => {
        const previous = oldVal[i] ?? ''
        const next = chars[i] ?? ''
        if (!rolling || previous === next) return <span key={`${i}-${next}`}>{next}</span>
        const top = dir === 'down' ? next : previous
        const bottom = dir === 'down' ? previous : next
        const lifted = dir === 'down' ? !shifted : shifted
        return (
          <span key={`${i}-${previous}-${next}-${dir}`} className="relative inline-block h-[1em] overflow-hidden align-[-0.05em] leading-[1em]">
            <span
              className="flex flex-col transition-transform duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none [&>span]:h-[1em] [&>span]:leading-[1em]"
              style={{ transform: lifted ? 'translateY(-1em)' : 'translateY(0)' }}
            >
              <span>{top}</span>
              <span>{bottom}</span>
            </span>
          </span>
        )
      })}
    </span>
  )
}

export function MessageActions({
  text,
  sentAt,
  onCopy,
  onVote,
  onReact,
  onReply,
  onFork,
}: {
  /** What Copy puts on the clipboard. */
  text: string
  sentAt?: Date
  onCopy?: (text: string) => void
  onVote?: (vote: Vote) => void
  onReact?: (emoji: string | null) => void
  onReply?: () => void
  onFork?: () => void
}) {
  const [vote, setVote] = useState<Vote>(null)
  const [copied, setCopied] = useState(false)
  const [panel, setPanel] = useState<'react' | 'more' | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reaction, setReaction] = useState<string | null>(null)
  const [extra, setExtra] = useState<string | null>(null)
  const [extraOut, setExtraOut] = useState(false)
  const [upN, setUpN] = useState(0)
  const [downN, setDownN] = useState(0)
  const [smileN, setSmileN] = useState(0)
  const [replyN, setReplyN] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const popId = useId()
  const menuId = useId()
  const [postedAt] = useState(() => sentAt ?? new Date())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 900)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!panel) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || pickerRef.current?.contains(target)) return
      setPanel(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [panel])

  useEffect(() => {
    if (panel === 'react') return
    setPickerOpen(false)
    setQuery('')
  }, [panel])

  useEffect(() => {
    if (panel === 'react' || !extraOut) return
    setExtra(null)
    setExtraOut(false)
  }, [panel, extraOut])

  useEffect(() => {
    if (pickerOpen) searchRef.current?.focus()
  }, [pickerOpen])

  const choose = (next: Vote) => {
    const value = vote === next ? null : next
    setVote(value)
    onVote?.(value)
    if (next === 'up') setUpN((n) => n + 1)
    if (next === 'down') setDownN((n) => n + 1)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* the drawn check still shows */
    }
    setCopied(true)
    onCopy?.(text)
  }

  const react = (emoji: string) => {
    const value = reaction === emoji ? null : emoji
    const preset = (REACTIONS as readonly string[]).includes(emoji)
    const fromRow = panel === 'react' && !pickerOpen
    setReaction(value)
    onReact?.(value)
    setPickerOpen(false)
    setQuery('')

    // A reaction from the picker joins the row as a seventh emoji until it is replaced or taken back.
    if (!preset && value) {
      setExtra(emoji)
      setExtraOut(false)
      setPanel(null)
      return
    }

    const leaveExtra = extra !== null && ((value === null && emoji === extra) || (value !== null && value !== extra))
    if (leaveExtra && fromRow && emoji === extra) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setExtra(null)
        setExtraOut(false)
      } else {
        setExtraOut(true)
      }
      return
    }
    if (leaveExtra) {
      setExtra(null)
      setExtraOut(false)
    }
    setPanel(null)
  }

  const emojiGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return EMOJI_GROUPS
    return EMOJI_GROUPS.map((group) => ({ label: group.label, items: group.items.filter(([, keywords]) => keywords.includes(q)) })).filter(
      (group) => group.items.length > 0,
    )
  }, [query])

  const placePicker = useCallback(() => {
    const anchor = rootRef.current
    const picker = pickerRef.current
    if (!anchor || !picker) return
    const rect = anchor.getBoundingClientRect()
    let top = rect.top - picker.offsetHeight - 8
    if (top < 8) top = rect.bottom + 8
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - picker.offsetWidth - 8)
    picker.style.left = `${Math.round(left)}px`
    picker.style.top = `${Math.round(top)}px`
  }, [])

  useIsoLayoutEffect(() => {
    if (!pickerOpen) return
    placePicker()
    window.addEventListener('scroll', placePicker, true)
    window.addEventListener('resize', placePicker)
    return () => {
      window.removeEventListener('scroll', placePicker, true)
      window.removeEventListener('resize', placePicker)
    }
  }, [pickerOpen, query, placePicker])

  const reply = () => {
    setReplyN((n) => n + 1)
    setPanel(null)
    onReply?.()
  }

  const more = (action: 'aloud' | 'fork' | 'report') => {
    if (action === 'fork') onFork?.()
    setPanel(null)
  }

  const minutes = elapsedMinutes(postedAt, now)
  const item =
    'mx-0.5 flex h-[26px] cursor-pointer items-center gap-1.5 rounded-(--control-radius) border-0 bg-transparent px-1.5 text-left text-xs leading-none whitespace-nowrap text-foreground outline-none hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] [&_svg]:flex-none [&_svg]:text-muted-foreground'

  return (
    <RowCues>
      <CueRoot rootRef={rootRef}>
        <Cue label="Good response">
          <button
            type="button"
            className={cn(BUTTON, 'data-[on=true]:text-emerald-600 dark:data-[on=true]:text-emerald-400')}
            data-on={vote === 'up'}
            aria-pressed={vote === 'up'}
            aria-label="Good response"
            onClick={() => choose('up')}
          >
            <GoodIcon key={upN} className={cn(GLYPH, 'origin-[50%_82%]', upN > 0 && 'motion-safe:animate-ma-thumb-up')} />
          </button>
        </Cue>

        <Cue label="Bad response">
          <button
            type="button"
            className={cn(BUTTON, 'data-[on=true]:text-destructive')}
            data-on={vote === 'down'}
            aria-pressed={vote === 'down'}
            aria-label="Bad response"
            onClick={() => choose('down')}
          >
            <BadIcon key={downN} className={cn(GLYPH, 'origin-[50%_18%]', downN > 0 && 'motion-safe:animate-ma-thumb-down')} />
          </button>
        </Cue>

        <Cue label={copied ? 'Copied' : 'Copy message'}>
          <button type="button" className={BUTTON} aria-label={copied ? 'Copied' : 'Copy message'} onClick={copy}>
            <span className="grid">
              <CopyIcon
                className={cn(GLYPH, 'origin-[50%_82%] [grid-area:1/1]', copied ? 'opacity-0 transition-none' : 'opacity-100 transition-opacity duration-[220ms] ease-[ease] motion-reduce:transition-none')}
              />
              <CopiedIcon
                drawing={copied}
                className={cn(
                  GLYPH,
                  'origin-[50%_82%] [grid-area:1/1] text-emerald-600 dark:text-emerald-400',
                  copied ? 'opacity-100 transition-none' : 'opacity-0 transition-opacity duration-[220ms] ease-[ease] motion-reduce:transition-none',
                )}
              />
            </span>
          </button>
        </Cue>

        <Cue label={reaction ? `Reaction ${reaction}` : 'Add reaction'} quiet={panel === 'react'}>
          <button
            type="button"
            className={BUTTON}
            data-on={panel === 'react' || reaction !== null}
            aria-expanded={panel === 'react'}
            aria-controls={popId}
            aria-label={reaction ? `Reaction ${reaction}` : 'Add reaction'}
            onClick={() => {
              setSmileN((n) => n + 1)
              setPanel((value) => (value === 'react' ? null : 'react'))
            }}
          >
            {reaction ? (
              <span key={reaction} className="block origin-center text-xs leading-none [translate:0_0.08em] motion-safe:animate-ma-reaction-in" aria-hidden="true">
                {reaction}
              </span>
            ) : (
              <SmileIcon key={smileN} className={cn(GLYPH, 'origin-[50%_60%]', smileN > 0 && 'ma-play motion-safe:animate-ma-smile-hop')} />
            )}
          </button>
        </Cue>

        <Cue label="Reply">
          <button type="button" className={BUTTON} aria-label="Reply" onClick={reply}>
            <ReplyIcon key={replyN} className={cn(GLYPH, 'origin-[50%_82%]', replyN > 0 && 'ma-play')} />
          </button>
        </Cue>

        <span className="relative inline-flex">
          <Cue label="More actions" quiet={panel === 'more'}>
            <button
              type="button"
              className={BUTTON}
              data-on={panel === 'more'}
              aria-expanded={panel === 'more'}
              aria-controls={menuId}
              aria-haspopup="menu"
              aria-label="More actions"
              onClick={() => setPanel((value) => (value === 'more' ? null : 'more'))}
            >
              <MoreIcon className={cn(GLYPH, 'origin-[50%_82%]')} />
            </button>
          </Cue>
          {panel === 'more' ? (
            <div
              id={menuId}
              role="menu"
              className={cn(MENU_SURFACE, 'absolute right-0 bottom-[calc(100%+8px)] z-[2] flex min-w-[120px] origin-[100%_100%] flex-col py-0.5 motion-safe:animate-ma-pop-in')}
            >
              <button type="button" className={item} role="menuitem" onClick={() => more('aloud')}>
                <AloudIcon />
                Read aloud
              </button>
              <button type="button" className={item} role="menuitem" onClick={() => more('fork')}>
                <ForkIcon />
                Fork chat
              </button>
              <div className="my-0.5 h-px bg-border" role="separator" />
              <button type="button" className={cn(item, 'text-destructive [&_svg]:text-destructive')} role="menuitem" onClick={() => more('report')}>
                <ReportIcon />
                Report
              </button>
            </div>
          ) : null}
        </span>

        {panel === 'react' && !pickerOpen ? (
          <div
            id={popId}
            role="menu"
            className={cn(MENU_SURFACE, 'absolute bottom-[calc(100%+8px)] left-0 z-[2] flex origin-[16px_100%] items-center p-0.5 motion-safe:animate-ma-pop-in')}
          >
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                data-on={reaction === emoji}
                aria-label={emoji}
                className={cn('inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-base leading-none outline-none', HOVER_FILL)}
                onClick={() => react(emoji)}
              >
                <span className="block leading-none">{emoji}</span>
              </button>
            ))}
            {extra ? (
              <button
                type="button"
                role="menuitem"
                data-on={!extraOut && reaction === extra}
                aria-label={extra}
                className={cn(
                  'inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-base leading-none outline-none',
                  HOVER_FILL,
                  extraOut && 'pointer-events-none overflow-hidden motion-safe:animate-ma-emoji-out',
                )}
                onClick={() => react(extra)}
                onAnimationEnd={(event) => {
                  if (event.target !== event.currentTarget || !extraOut) return
                  setExtra(null)
                  setExtraOut(false)
                }}
              >
                <span className="block leading-none">{extra}</span>
              </button>
            ) : null}
            <button
              type="button"
              data-on={pickerOpen}
              aria-expanded={pickerOpen}
              aria-label="Search emoji"
              className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground"
              onClick={() => setPickerOpen((value) => !value)}
            >
              <AddEmojiIcon size={16} />
            </button>
          </div>
        ) : null}

        {panel === 'react' && pickerOpen
          ? createPortal(
              <div ref={pickerRef} role="dialog" aria-label="Search emoji" className={cn(MENU_SURFACE, 'fixed z-30 w-[286px] overflow-hidden motion-safe:animate-ma-pop-in')}>
                <label className="flex items-center gap-2 border-b border-border py-2 pr-3 pl-2.5 text-muted-foreground">
                  <SearchIcon size={16} />
                  <input
                    ref={searchRef}
                    value={query}
                    placeholder="Search emoji"
                    aria-label="Search emoji"
                    className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="max-h-[248px] overflow-x-hidden overflow-y-auto pr-1 pb-2.5 pl-2 [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]">
                  {emojiGroups.length === 0 ? (
                    <p className="mx-2 my-4 text-xs text-muted-foreground">No emoji found</p>
                  ) : (
                    emojiGroups.map((group) => (
                      <section key={group.label}>
                        <p className="mx-1 mt-2.5 mb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
                        <div className="grid grid-cols-[repeat(8,32px)] gap-0.5">
                          {group.items.map(([emoji]) => (
                            <button
                              key={emoji}
                              type="button"
                              data-on={reaction === emoji}
                              aria-label={emoji}
                              className={cn('inline-flex size-8 cursor-pointer items-center justify-center rounded-(--control-radius) border-0 bg-transparent p-0 text-xl leading-none outline-none', HOVER_FILL)}
                              onClick={() => react(emoji)}
                            >
                              <span className="block leading-none [translate:0_0.08em]">{emoji}</span>
                            </button>
                          ))}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              </div>,
              document.body,
            )
          : null}

        <Cue label={formatAbsolute(postedAt)}>
          <time
            dateTime={postedAt.toISOString()}
            className="ml-1 inline-flex h-5 cursor-default items-center text-xs leading-none whitespace-nowrap text-muted-foreground tabular-nums opacity-0 transition-opacity duration-200 ease-[ease] group-focus-within/actions:opacity-100 group-hover/actions:opacity-100 motion-reduce:transition-none"
          >
            {minutes >= 1 && minutes < 60 ? (
              <>
                <MinuteRoll value={String(minutes)} />m ago
              </>
            ) : (
              formatAgo(postedAt, now)
            )}
          </time>
        </Cue>
      </CueRoot>
    </RowCues>
  )
}
