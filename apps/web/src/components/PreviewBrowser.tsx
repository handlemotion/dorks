import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  MonitorIcon,
  SmartphoneIcon,
  TabletIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  RotateCwIcon,
  RulerIcon,
  SquareDashedIcon,
  SquareMousePointerIcon,
  TextCursorIcon,
} from 'lucide-react'
import { commentThreads, type CommentAnchor, type CommentView } from '@dorks/shared'
import type { DorksClient, QueryState, Store } from '@dorks/client'
import { useOptionalDorksClient } from '@dorks/client/react'
import { Button, buttonVariants } from '@dorks/ui/button'
import type { Names, ThreadActions } from './preview/CommentThread'
import { ProviderIcon, type AgentProvider } from './ChatComposer'
import { PreviewMarks, useSize } from './preview/PreviewMarks'
import { MARGIN, RULER, Rulers } from './preview/Rulers'
import { useOverlay, type Overlay, type Picked, type PickMode, type Rect } from './preview/useOverlay'
import { Tip } from './Tip'

/** A dev server running in the sandbox. `html` renders an inline (same-origin) page instead of the URL; the dev demo uses it. */
export type PreviewServer = {
  name: string
  url: string
  html?: string
  /** Overrides the page's own `/favicon.ico`. */ favicon?: string
  /** Shown as `:3000`; a hosted preview's URL carries no port of its own. */ port?: number
}

/**
 * Calls `onShown` with each server that appears after the first render: the agent just showed it (preview_show). The servers there
 * from the start are not new, so opening Chat details never jumps anywhere by itself.
 */
export function useShownServers(servers: PreviewServer[] | undefined, onShown: (server: PreviewServer) => void) {
  const seen = useRef<Set<string> | null>(null)
  const latest = useRef(onShown)
  latest.current = onShown
  const key = (servers ?? []).map((s) => s.url).join('\n')
  useEffect(() => {
    const list = servers ?? []
    if (!seen.current) {
      seen.current = new Set(list.map((s) => s.url))
      return
    }
    const fresh = list.filter((s) => !seen.current!.has(s.url))
    for (const s of fresh) seen.current.add(s.url)
    if (fresh.length) latest.current(fresh[fresh.length - 1])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the URLs, not the array identity
  }, [key])
}

/** The buttons in Chat details' bars (tabs row, browser bar): 30px, muted, the tabs' hover. */
export const BAR_BUTTON = "size-[30px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5"

type Primitives = typeof import('react-grab/primitives')
type Box = { x: number; y: number; width: number; height: number; radius: string; label: string }

/** `http://localhost:5173` reads as `:5173`; a URL with no port keeps its host. */
export function port(url: string) {
  try {
    const u = new URL(url)
    return u.port ? `:${u.port}` : u.host
  } catch {
    return url
  }
}

/** The session a preview belongs to: comments need it (the dev demo has none). */
export type PreviewSession = { id: string; agent: string; provider: AgentProvider }

const NONE = { data: undefined }
const noSubscribe = () => () => {}
const none = () => NONE

/** A client store's data, or undefined without one (no session, or no client: the dev demo). */
export function useMaybe<T>(store: Store<QueryState<T>> | null): T | undefined {
  const get: () => { data?: T } = store?.getSnapshot ?? none
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, get, get).data
}

/** The fill around the page: a step lighter than the app's grey, so the white tool hover still reads. */
const BACKDROP = 'bg-[color-mix(in_oklab,var(--app),var(--background)_55%)]'
/** A tool or size that is on: a light blue. */
const PRESSED = 'aria-pressed:bg-brand/[0.07] aria-pressed:text-[color-mix(in_oklab,var(--brand),white_30%)] aria-pressed:hover:bg-brand/[0.1]'

/** The sizes a preview can be seen at, each scaled down to fit the panel: a landscape desktop window, a tablet, a phone. */
const DEVICES = {
  desktop: { label: 'Desktop (1440 × 900)', icon: MonitorIcon, width: 1440, height: 900 },
  tablet: { label: 'Tablet (820 × 1180)', icon: TabletIcon, width: 820, height: 1180 },
  phone: { label: 'Phone (390 × 844)', icon: SmartphoneIcon, width: 390, height: 844 },
} as const
type Device = keyof typeof DEVICES
const DEVICE_KEY = 'dorks.preview.device'

/** The size the owner last chose, remembered across previews. */
function useDevice(): [Device, (d: Device) => void] {
  const [device, set] = useState<Device>(() => {
    try {
      const saved = localStorage.getItem(DEVICE_KEY)
      return saved && saved in DEVICES ? (saved as Device) : 'desktop'
    } catch {
      return 'desktop'
    }
  })
  return [
    device,
    (d) => {
      set(d)
      try {
        localStorage.setItem(DEVICE_KEY, d)
      } catch {
        // private mode: it lasts for this view
      }
    },
  ]
}

/** The page's own size and how much it is scaled to fit `room`, centred in it. */
function viewport(room: { width: number; height: number }, d: { width: number; height: number }) {
  if (!room.width || !room.height) return { width: d.width, height: d.height, scale: 1, left: 0, top: 0 }
  const scale = Math.min(1, room.width / d.width, room.height / d.height)
  return { width: d.width, height: d.height, scale, left: (room.width - d.width * scale) / 2, top: (room.height - d.height * scale) / 2 }
}

const scaleRect = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s })
const onScreen = (p: Picked | null, s: number) => p && { ...p, box: scaleRect(p.box, s) }
/** The overlay's hover box is in the page's pixels; the same-origin picker's is already on screen. */
const hoverOnScreen = (hover: Box | null, sameOrigin: Box | null, s: number) => (hover ? { ...hover, ...scaleRect(hover, s) } : sameOrigin)

/** How the threads show their authors: the GitHub login and avatar when there is one, the agent's name and mark. */
export function namesOf(login: string | null | undefined, session: PreviewSession | undefined): Names {
  return {
    owner: login ?? 'You',
    ...(login ? { ownerImage: `https://github.com/${encodeURIComponent(login)}.png?size=64` } : {}),
    agent: session?.agent ?? 'Agent',
    agentIcon: session ? <ProviderIcon provider={session.provider} /> : null,
  }
}

/** What the overlay needs beyond the selector to find an anchor again: the quoted words, or the area's rectangle. */
const markExtra = (a: CommentAnchor) => (a.kind === 'text' ? { quote: a.quote, prefix: a.prefix, suffix: a.suffix } : a.kind === 'area' ? { rect: a.rect } : {})

/** A drawn rectangle from two corners. */
const between = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })

/**
 * The same-origin picker (the dev demo, whose page has no overlay): React Grab's primitives reaching into the frame's document.
 * Hovering highlights the element under the pointer (`box`, in the stage's coordinates), a click hands its snippet to `onGrab`.
 */
function useSameOriginPicker(frame: React.RefObject<HTMLIFrameElement | null>, stage: React.RefObject<HTMLDivElement | null>, on: boolean, done: () => void, onGrab?: (snippet: string) => void) {
  const [box, setBox] = useState<Box | null>(null)
  const grab = useRef<Primitives | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!on || grab.current) return
    void import('react-grab/primitives').then((g) => {
      grab.current = g
      setLoaded(true)
    })
  }, [on])
  useEffect(() => {
    const doc = frame.current?.contentDocument
    const g = grab.current
    if (!on || !doc || !g) return setBox(null)
    const at = (e: MouseEvent) => doc.elementsFromPoint(e.clientX, e.clientY).find((el) => g.isElementGrabbable(el)) ?? null
    const onMove = (e: MouseEvent) => {
      const el = at(e)
      const origin = stage.current?.getBoundingClientRect()
      if (!el || !origin) return setBox(null)
      const b = g.getElementBounds(el)
      setBox({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height, radius: b.borderRadius, label: el.tagName.toLowerCase() })
    }
    const onClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = at(e)
      if (!el) return
      done()
      // The selector starts at this app's frame (`[title="Preview"] >>iframe>> …`); the agent only needs the part inside the page.
      void g.getElementContext(el).then((ctx) => onGrab?.(ctx.snippet.replace(/\S+ >>iframe>> /g, '')))
    }
    const block = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done()
    const onLeave = () => setBox(null)
    const cursor = doc.documentElement.style.cursor
    doc.documentElement.style.cursor = 'crosshair'
    doc.addEventListener('mousemove', onMove, true)
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('mousedown', block, true)
    doc.addEventListener('mouseleave', onLeave)
    doc.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onKey)
    return () => {
      setBox(null)
      doc.documentElement.style.cursor = cursor
      doc.removeEventListener('mousemove', onMove, true)
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('mousedown', block, true)
      doc.removeEventListener('mouseleave', onLeave)
      doc.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onKey)
    }
  }, [on, loaded, frame, stage, done, onGrab])
  return box
}

/** The session's comment threads on this preview, what is drawn of them now, and what the threads can do. */
function usePreviewComments(
  client: DorksClient | null,
  session: PreviewSession | undefined,
  port: number | undefined,
  overlay: Overlay,
  tools: boolean,
  showComments: boolean,
  setActive: (f: (a: string | null) => string | null) => void,
) {
  const all = useMaybe<CommentView[]>(useMemo(() => (client && session ? client.comments(session.id) : null), [client, session?.id])) // eslint-disable-line react-hooks/exhaustive-deps
  const threads = useMemo(() => commentThreads(all ?? []).filter((t) => port === undefined || t.root.port === port), [all, port])
  const open = useMemo(() => threads.filter((t) => !t.root.resolvedAt), [threads])
  const { setMarks, rects } = overlay
  useEffect(() => {
    if (!tools) return
    setMarks(
      open.flatMap((t) => {
        const a = t.root.anchor
        if (!a || a.kind === 'image') return []
        return [{ id: t.root.id, kind: a.kind, path: a.path, selector: a.selector, ...markExtra(a) }]
      }),
    )
  }, [tools, open, setMarks])
  const shown = useMemo(() => (showComments ? open.flatMap((thread) => (rects.get(thread.root.id) ? [{ thread, rects: rects.get(thread.root.id)! }] : [])) : []), [open, rects, showComments])
  const id = session?.id ?? ''
  const actions: ThreadActions = {
    reply: (thread, body) => client!.actions.replyComment(id, thread, body),
    resolve: async (thread, resolved) => {
      await client!.actions.changeComment(id, thread, { resolved })
      if (resolved) setActive(() => null)
    },
    edit: (comment, body) => client!.actions.changeComment(id, comment, { body }),
    remove: async (comment) => {
      await client!.actions.deleteComment(id, comment)
      setActive((a) => (a === comment ? null : a))
    },
  }
  return { threads, open, shown, actions }
}

/** Draws a rectangle over the page; `onDrawn` gets it (in the frame's viewport) once it is big enough to mean something. */
function DrawLayer({ onDrawn }: { onDrawn: (rect: Rect) => void }) {
  const from = useRef<{ x: number; y: number } | null>(null)
  const [drawn, setDrawn] = useState<Rect | null>(null)
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }
  }
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        from.current = point(e)
        setDrawn(null)
      }}
      onPointerMove={(e) => from.current && setDrawn(between(from.current, point(e)))}
      onPointerUp={(e) => {
        const start = from.current
        from.current = null
        setDrawn(null)
        if (!start) return
        const rect = between(start, point(e))
        if (rect.width >= 8 && rect.height >= 8) onDrawn(rect)
      }}
    >
      {drawn && <div className="absolute border border-brand bg-brand/10" style={{ left: drawn.x, top: drawn.y, width: drawn.width, height: drawn.height }} />}
    </div>
  )
}

export function ToolButton({ label, icon, pressed, onClick, count, className = '' }: { label: string; icon: ReactNode; pressed: boolean; onClick: () => void; count?: number; className?: string }) {
  return (
    <Tip label={label} side="top">
      <Button
        variant="ghost"
        size="icon-sm"
        className={`h-7 w-auto min-w-7 gap-1 rounded-[6px] px-[7px] text-muted-foreground transition-none hover:bg-foreground/[0.05] hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5 ${PRESSED} ${className}`}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {icon}
        {count ? <span className="text-xs tabular-nums">{count}</span> : null}
      </Button>
    </Tip>
  )
}

type Tool = 'comment' | 'text' | 'attach' | 'capture'

/** Which tool is on: drawing an area, picking text, or picking an element for a comment or a message. */
function activeToolOf(s: { drawing: boolean; picking: PickMode | null; intent: 'comment' | 'attach'; sameOriginPicking: boolean }): Tool | null {
  if (s.drawing) return 'capture'
  if (s.picking) return s.picking === 'text' ? 'text' : s.intent
  return s.sameOriginPicking ? 'attach' : null
}

/** The element under the pointer while picking, outlined, with its tag. */
function HoverOutline({ box }: { box: Box | null }) {
  if (!box) return null
  return (
    <div className="absolute rounded-[4px] border border-brand bg-brand/10" style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: box.radius }}>
      <span className={`absolute left-0 rounded-(--control-radius) ${box.y < 28 ? 'top-0 m-1' : 'bottom-full mb-1'} bg-brand px-1.5 py-0.5 font-mono text-xs text-white`}>{box.label}</span>
    </div>
  )
}

/** The bar over the page: Back (to the artifacts), Reload, the server's name, port and page, and Open in a new tab. */
function PreviewBar({
  server,
  path,
  onBack,
  onReload,
  device,
  onDevice,
}: {
  server: PreviewServer
  path: string
  onBack: () => void
  onReload: () => void
  device: Device
  onDevice: (d: Device) => void
}) {
  return (
    <>
      {/* Same rhythm as the tab row above: 30px buttons, icons in line with the tab icons and the hide button (measured: same left and right edges). */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-(--details-edge)">
        <Tip label="All artifacts">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="All artifacts" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <Tip label="Reload">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Reload" onClick={onReload}>
            <RotateCwIcon />
          </Button>
        </Tip>
        <p className="mx-2 flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="truncate">{server.name}</span>
          <span className="shrink-0 text-muted-foreground">{server.port ? `:${server.port}` : port(server.url)}</span>
          {path !== '/' && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>}
        </p>
        {(Object.keys(DEVICES) as Device[]).map((d) => {
          const Icon = DEVICES[d].icon
          return (
            <Tip key={d} label={DEVICES[d].label}>
              <Button variant="ghost" size="icon-sm" className={`${BAR_BUTTON} ${PRESSED}`} aria-label={DEVICES[d].label} aria-pressed={device === d} onClick={() => onDevice(d)}>
                <Icon />
              </Button>
            </Tip>
          )
        })}
        {!server.html && (
          <Tip label="Open in a new tab">
            <a href={server.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" className={`${buttonVariants({ variant: 'ghost', size: 'icon-sm' })} ${BAR_BUTTON}`}>
              <ExternalLinkIcon />
            </a>
          </Tip>
        )}
      </div>
    </>
  )
}

/** The bar under the page: the tools, then Show comments. Only a page with the overlay has them all. */
function PreviewToolbar(props: {
  /** `overlay`: every tool; `same-origin`: only the picker (the dev demo); `loading`: the page has not answered yet. */
  mode: 'overlay' | 'same-origin' | 'loading' | 'none'
  session?: PreviewSession
  active: Tool | null
  onTool: (tool: Tool) => void
  showComments: boolean
  onShowComments: () => void
  rulers: boolean
  onRulers: () => void
  openCount: number
}) {
  const session = props.mode === 'overlay' ? props.session : undefined
  if (props.mode === 'loading') return <span className="text-xs text-muted-foreground">Comments and tools appear once the page loads.</span>
  if (props.mode === 'none') return null
  if (!session)
    return (
      <Rail>
        <ToolButton label="Select an element to send to the agent" icon={<SquareMousePointerIcon />} pressed={props.active === 'attach'} onClick={() => props.onTool('attach')} />
      </Rail>
    )
  return (
    <Rail>
      <ToolButton label="Comment on an element" icon={<MessageSquarePlusIcon />} pressed={props.active === 'comment'} onClick={() => props.onTool('comment')} />
      <ToolButton label="Comment on text" icon={<TextCursorIcon />} pressed={props.active === 'text'} onClick={() => props.onTool('text')} />
      <ToolButton label="Comment on an area" icon={<SquareDashedIcon />} pressed={props.active === 'capture'} onClick={() => props.onTool('capture')} />
      <ToolButton label={props.rulers ? 'Hide rulers' : 'Rulers'} icon={<RulerIcon />} pressed={props.rulers} onClick={props.onRulers} />
      <RailDivider />
      <ToolButton
        label={props.showComments ? 'Hide comments' : 'Show comments'}
        icon={<MessagesSquareIcon />}
        pressed={props.showComments && props.openCount > 0}
        onClick={props.onShowComments}
        count={props.openCount}
      />
    </Rail>
  )
}

/** The rail the tools sit on, after omni's preview rail: white, a hairline, 2px around 28px tools. */
export function Rail({ children, label = 'Preview tools' }: { children: ReactNode; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} className="flex items-center gap-0.5 rounded-[8px] border bg-background p-0.5">
      {children}
    </div>
  )
}

/** Splits groups of tools: a full-height hairline from rail edge to rail edge. */
export function RailDivider() {
  return <span aria-hidden className="mx-0.5 -my-0.5 w-px self-stretch bg-border" />
}

/**
 * A running preview, opened from its Artifacts tile: what the agent showed with `preview_show` (a dev server, hosted by the box
 * provider). Under a bar with Back (to the artifacts), Reload, the server's name and Open in a new tab, the page sits as an island on
 * the panel's fill, with a toolbar under it:
 *
 * - **Comment** on an element or on a passage of text. Comments are threads Dorks keeps (services/comments.ts): a bubble over the
 *   element, the text highlighted, the thread beside it. The agent hears about them as a notification and answers in the thread.
 * - **Capture an area**: a comment on a drawn rectangle, with its screenshot (the agent sees the image).
 * - **Show comments** or hide them.
 *
 * All of it works through the overlay the bridge's preview proxy adds to the page (infra/bridge/overlay/overlay.ts), over
 * postMessage, since the page is on another origin. A same-origin page (the dev demo) has no overlay: there only the element picker
 * works, with React Grab's primitives reaching into the frame, and the pick goes to `onGrab`.
 */
export function PreviewBrowser({ server, onBack, onGrab, session }: { server: PreviewServer; onBack: () => void; onGrab?: (snippet: string) => void; session?: PreviewSession }) {
  const maybeClient = useOptionalDorksClient()
  // Only a preview with a session talks to the server; the dev demo renders this without a client.
  const client = session ? maybeClient : null
  const settings = useMaybe(useMemo(() => client?.settings() ?? null, [client]))
  const current = server.url
  const html = server.html
  const [reloads, setReloads] = useState(0)
  const [sameOrigin, setSameOrigin] = useState(false)
  const [sameOriginPicking, setSameOriginPicking] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [device, setDevice] = useDevice()
  const areaSize = useSize(area)
  const view = viewport(areaSize, DEVICES[device])

  // The comment being written, the area being drawn.
  const intent = session ? 'comment' : 'attach'
  const [draft, setDraft] = useState<Picked | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [showComments, setShowComments] = useState(true)
  const [rulers, setRulers] = useState(false)
  const [problem, setProblem] = useState('')

  const overlay = useOverlay(frame, current, reloads, (p) => {
    // One element tool: the pick opens a comment on it.
    if (session) {
      setActive(null)
      setDraft(p)
    } else if (p.snippet) onGrab?.(p.snippet)
  })
  const tools = overlay.ready && !html
  // With rulers on, the page is laid out in the room right of and below them.
  const ruled = rulers && tools ? RULER : 0
  const comments = usePreviewComments(client, session, server.port, overlay, tools, showComments, setActive)
  const stopSameOrigin = useCallback(() => setSameOriginPicking(false), [])
  const sameOriginBox = useSameOriginPicker(frame, stage, sameOriginPicking && !tools, stopSameOrigin, onGrab)

  useEffect(() => {
    setSameOriginPicking(false)
    setSameOrigin(false)
    setDraft(null)
    setActive(null)
    setDrawing(false)
  }, [current, reloads])
  const { track } = overlay
  useEffect(() => {
    if (tools) track(rulers)
  }, [tools, rulers, track])
  useEffect(() => {
    if (!drawing) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawing(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing])

  /** A drawn area becomes a comment on it: its screenshot is uploaded now, the comment box opens beside it. */
  const capture = async (rect: Rect) => {
    setDrawing(false)
    setCapturing(true)
    setProblem('')
    try {
      const shot = await overlay.capture(rect)
      const image = client ? await client.actions.uploadImage(await (await fetch(shot.data)).blob()) : undefined
      const doc = { ...rect, x: rect.x + shot.scroll.x, y: rect.y + shot.scroll.y }
      setActive(null)
      setDraft({ anchor: { kind: 'area', path: overlay.path, selector: '', label: 'area', rect: doc, ...(image ? { image } : {}) }, box: rect })
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'The area could not be captured.')
    } finally {
      setCapturing(false)
    }
  }

  const activeTool = activeToolOf({ drawing: drawing || capturing, picking: overlay.picking, intent, sameOriginPicking })
  const onTool = (tool: Tool) => {
    setDraft(null)
    if (!tools) return setSameOriginPicking((p) => !p)
    if (tool === 'capture') {
      overlay.pick(null)
      return setDrawing((d) => !d)
    }
    setDrawing(false)
    if (activeTool === tool) return overlay.pick(null)
    overlay.pick(tool === 'text' ? 'text' : 'element')
  }
  // The overlay reports positions in the page's own pixels; the page is drawn scaled to fit.
  const shownOnScreen = useMemo(() => comments.shown.map((t) => ({ ...t, rects: t.rects.map((r) => scaleRect(r, view.scale)) })), [comments.shown, view.scale])
  const names = namesOf(settings?.github.login, session)

  return (
    <>
      <PreviewBar server={server} path={tools ? overlay.path : '/'} onBack={onBack} onReload={() => setReloads((n) => n + 1)} device={device} onDevice={setDevice} />
      <div className={`relative flex min-h-0 flex-1 flex-col ${BACKDROP}`}>
        <div ref={area} className="relative min-h-0 flex-1" style={{ margin: `${MARGIN + ruled}px ${MARGIN}px 0 ${MARGIN + ruled}px` }}>
          <div
            ref={stage}
            className="absolute overflow-hidden rounded-[8px] border border-surface-line bg-white dark:border-transparent"
            style={{ left: view.left, top: view.top, width: view.width * view.scale, height: view.height * view.scale }}
          >
            <iframe
              key={`${current}:${reloads}`}
              ref={frame}
              src={html ? undefined : current}
              srcDoc={html}
              title="Preview"
              className="origin-top-left bg-white"
              style={{ width: view.width, height: view.height, transform: view.scale === 1 ? undefined : `scale(${view.scale})` }}
              onLoad={() => {
                // Ask again in case the overlay's first "ready" came before this listener; a page without it never answers.
                if (!html) overlay.hello()
                try {
                  setSameOrigin(!!frame.current?.contentDocument)
                } catch {
                  setSameOrigin(false)
                }
              }}
            />
            <PreviewMarks
              threads={shownOnScreen}
              names={names}
              actions={comments.actions}
              active={active}
              setActive={setActive}
              draft={onScreen(draft, view.scale)}
              onDraftSend={(body) => client!.actions.addComment(session!.id, { body, anchor: draft!.anchor, port: server.port ?? 0 })}
              onDraftClose={() => setDraft(null)}
            >
              <HoverOutline box={hoverOnScreen(overlay.hover, sameOriginBox, view.scale)} />
            </PreviewMarks>
            {drawing && <DrawLayer onDrawn={(rect) => void capture(scaleRect(rect, 1 / view.scale))} />}
          </div>
        </div>
        <Rulers on={ruled > 0} view={view} offset={{ x: MARGIN + ruled, y: MARGIN + ruled }} pointer={overlay.pointer} />
        <div className="flex shrink-0 justify-center px-5 pt-3 pb-4">
          <PreviewToolbar
            mode={tools ? 'overlay' : sameOrigin ? 'same-origin' : html ? 'none' : 'loading'}
            session={session}
            active={activeTool}
            onTool={onTool}
            showComments={showComments}
            onShowComments={() => setShowComments((s) => !s)}
            rulers={rulers}
            onRulers={() => setRulers((r) => !r)}
            openCount={comments.open.length}
          />
        </div>
        {problem && (
          <p role="alert" className="absolute inset-x-0 bottom-12 text-center text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
    </>
  )
}
