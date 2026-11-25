import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowLeftIcon, ExternalLinkIcon, MessageCircleIcon, MessageSquarePlusIcon, MessagesSquareIcon, RotateCwIcon, ScanIcon, SquareMousePointerIcon, TextCursorIcon } from 'lucide-react'
import { anchorLine, commentThreads, type CommentView } from '@dorks/shared'
import type { DorksClient, QueryState, Store } from '@dorks/client'
import { useOptionalDorksClient } from '@dorks/client/react'
import { Button, buttonVariants } from '@dorks/ui/button'
import { CommandIsland, type Chip } from './preview/CommandIsland'
import type { ThreadActions } from './preview/CommentThread'
import { PreviewMarks } from './preview/PreviewMarks'
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

/** The session a preview belongs to: comments and the command island need it (the dev demo has none). */
export type PreviewSession = { id: string; agent: string }

const NONE = { data: undefined }
const noSubscribe = () => () => {}
const none = () => NONE

/** A client store's data, or undefined without one (no session, or no client: the dev demo). */
function useMaybe<T>(store: Store<QueryState<T>> | null): T | undefined {
  const get: () => { data?: T } = store?.getSnapshot ?? none
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, get, get).data
}

/** What the command island sends: the text, then what each chip stands for, as the agent should read it, then where it came from. */
async function islandMessage(text: string, chips: Chip[], server: PreviewServer, path: string, upload: (blob: Blob) => Promise<string>) {
  const parts = [text]
  for (const c of chips) parts.push(await chipText(c, upload))
  parts.push(`(From the preview of ${server.name}${server.port ? ` on port ${server.port}` : ''}, page ${path}.)`)
  return parts.filter(Boolean).join('\n\n')
}

async function chipText(c: Chip, upload: (blob: Blob) => Promise<string>) {
  switch (c.kind) {
    case 'element':
      return `Element on ${c.path}:\n\`\`\`\n${c.snippet}\n\`\`\``
    case 'image':
      return `![${c.label.replace(/[[\]\n]/g, ' ')}](dorks-image:${await upload(await (await fetch(c.dataUrl)).blob())})`
    case 'comment': {
      const r = c.thread.root
      return `About comment ${r.id}${r.anchor ? ` (${anchorLine(r.anchor)})` : ''}: "${r.body}"`
    }
    case 'preview':
      return `The preview ${c.label}${c.port ? ` (port ${c.port})` : ''}: ${c.url}`
  }
}

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
        if (!a) return []
        return [{ id: t.root.id, kind: a.kind, path: a.path, selector: a.selector, ...(a.kind === 'text' ? { quote: a.quote, prefix: a.prefix, suffix: a.suffix } : {}) }]
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

function ToolButton({ label, icon, pressed, onClick, count }: { label: string; icon: ReactNode; pressed: boolean; onClick: () => void; count?: number }) {
  return (
    <Tip label={label} side="top">
      <Button
        variant="ghost"
        size="icon-sm"
        className={`${BAR_BUTTON} w-auto min-w-[30px] gap-1 px-[8px] aria-pressed:bg-brand/10 aria-pressed:text-brand`}
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
function PreviewBar({ server, path, onBack, onReload }: { server: PreviewServer; path: string; onBack: () => void; onReload: () => void }) {
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

/** The bar under the page: the tools, then Show comments and the command island. Only a page with the overlay has them all. */
function PreviewToolbar(props: {
  /** `overlay`: every tool; `same-origin`: only the picker (the dev demo); `loading`: the page has not answered yet. */
  mode: 'overlay' | 'same-origin' | 'loading' | 'none'
  session?: PreviewSession
  active: Tool | null
  onTool: (tool: Tool) => void
  showComments: boolean
  onShowComments: () => void
  openCount: number
  island: boolean
  onIsland: () => void
  chipCount: number
}) {
  const session = props.mode === 'overlay' ? props.session : undefined
  if (props.mode === 'loading') return <span className="text-xs text-muted-foreground">Comments and tools appear once the page loads.</span>
  if (props.mode === 'none') return null
  if (!session) return <ToolButton label="Select an element to send to the agent" icon={<SquareMousePointerIcon />} pressed={props.active === 'attach'} onClick={() => props.onTool('attach')} />
  return (
    <>
      <ToolButton label="Comment on an element" icon={<MessageSquarePlusIcon />} pressed={props.active === 'comment'} onClick={() => props.onTool('comment')} />
      <ToolButton label="Comment on text" icon={<TextCursorIcon />} pressed={props.active === 'text'} onClick={() => props.onTool('text')} />
      <ToolButton label="Add an element to a message" icon={<SquareMousePointerIcon />} pressed={props.active === 'attach'} onClick={() => props.onTool('attach')} />
      <ToolButton label="Capture an area" icon={<ScanIcon />} pressed={props.active === 'capture'} onClick={() => props.onTool('capture')} />
      <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
      <ToolButton
        label={props.showComments ? 'Hide comments' : 'Show comments'}
        icon={<MessagesSquareIcon />}
        pressed={props.showComments && props.openCount > 0}
        onClick={props.onShowComments}
        count={props.openCount}
      />
      <ToolButton label={`Message ${session.agent}`} icon={<MessageCircleIcon />} pressed={props.island} onClick={props.onIsland} count={props.chipCount} />
    </>
  )
}

/**
 * A running preview, opened from its Artifacts tile: what the agent showed with `preview_show` (a dev server, hosted by the box
 * provider). Under a bar with Back (to the artifacts), Reload, the server's name and Open in a new tab, the page sits as an island on
 * the panel's fill, with a toolbar under it:
 *
 * - **Comment** on an element or on a passage of text. Comments are threads Dorks keeps (services/comments.ts): a bubble over the
 *   element, the text highlighted, the thread beside it. The agent hears about them as a notification and answers in the thread.
 * - **Add an element** or **capture an area** for a message: they become chips in the command island.
 * - **Show comments**, and the **command island**: a small message box for the agent with those chips and @ mentions.
 *
 * All of it works through the overlay the bridge's preview proxy adds to the page (infra/bridge/overlay/overlay.ts), over
 * postMessage, since the page is on another origin. A same-origin page (the dev demo) has no overlay: there only the element picker
 * works, with React Grab's primitives reaching into the frame, and the pick goes to `onGrab`.
 */
export function PreviewBrowser({
  server,
  onBack,
  onGrab,
  session,
  previews = [],
}: {
  server: PreviewServer
  onBack: () => void
  onGrab?: (snippet: string) => void
  session?: PreviewSession
  /** Every running preview, for @ mentions. */
  previews?: PreviewServer[]
}) {
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

  // What an element pick is for, the island and its chips, the comment being written, the area being drawn.
  const [intent, setIntent] = useState<'comment' | 'attach'>('comment')
  const [island, setIsland] = useState(false)
  const [chips, setChips] = useState<Chip[]>([])
  const [draft, setDraft] = useState<Picked | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [showComments, setShowComments] = useState(true)
  const [problem, setProblem] = useState('')

  const addChip = useCallback((chip: Chip) => setChips((cs) => (cs.some((c) => c.key === chip.key) ? cs : [...cs, chip])), [])
  const overlay = useOverlay(frame, current, reloads, (p) => {
    if (intent === 'attach' && p.snippet && session) {
      const a = p.anchor
      addChip({ kind: 'element', key: `element:${a.path}:${a.selector}`, label: a.component ? `<${a.label}> ${a.component}` : `<${a.label}>`, snippet: p.snippet, path: a.path })
      setIsland(true)
    } else if (session) {
      setActive(null)
      setDraft(p)
    } else if (p.snippet) onGrab?.(p.snippet)
  })
  const tools = overlay.ready && !html
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
  useEffect(() => {
    if (!drawing) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawing(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing])

  const capture = async (rect: Rect) => {
    setDrawing(false)
    setCapturing(true)
    setProblem('')
    try {
      const dataUrl = await overlay.capture(rect)
      addChip({ kind: 'image', key: `image:${Date.now()}`, label: `Area of ${overlay.path}`, dataUrl, path: overlay.path })
      setIsland(true)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'The area could not be captured.')
    } finally {
      setCapturing(false)
    }
  }
  const sendIsland = async (text: string) => {
    if (!session || !client) return
    await client.actions.sendMessage(session.id, await islandMessage(text, chips, server, overlay.path, (blob) => client.actions.uploadImage(blob)))
    setChips([])
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
    setIntent(tool === 'attach' ? 'attach' : 'comment')
    overlay.pick(tool === 'text' ? 'text' : 'element')
  }
  const names = { owner: settings?.github.login ?? 'You', agent: session?.agent ?? 'Agent' }

  return (
    <>
      <PreviewBar server={server} path={tools ? overlay.path : '/'} onBack={onBack} onReload={() => setReloads((n) => n + 1)} />
      <div className="relative flex min-h-0 flex-1 flex-col bg-app">
        <div ref={stage} className="relative mx-2.5 mt-2.5 min-h-0 flex-1 overflow-hidden rounded-[8px] border border-surface-line bg-white dark:border-transparent">
          <iframe
            key={`${current}:${reloads}`}
            ref={frame}
            src={html ? undefined : current}
            srcDoc={html}
            title="Preview"
            className="size-full bg-white"
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
            threads={comments.shown}
            names={names}
            actions={comments.actions}
            active={active}
            setActive={setActive}
            draft={draft}
            onDraftSend={(body) => client!.actions.addComment(session!.id, { body, anchor: draft!.anchor, port: server.port ?? 0 })}
            onDraftClose={() => setDraft(null)}
          >
            <HoverOutline box={overlay.hover ?? sameOriginBox} />
          </PreviewMarks>
          {drawing && <DrawLayer onDrawn={(rect) => void capture(rect)} />}
        </div>
        {island && session && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-6">
            <div className="pointer-events-auto w-full max-w-[460px]">
              <CommandIsland
                agent={session.agent}
                chips={chips}
                onAddChip={addChip}
                onRemoveChip={(key) => setChips((cs) => cs.filter((c) => c.key !== key))}
                threads={comments.threads}
                previews={previews.filter((p) => p.url !== server.url)}
                onSend={sendIsland}
                onClose={() => setIsland(false)}
              />
            </div>
          </div>
        )}
        <div className="flex h-12 shrink-0 items-center justify-center gap-0.5 px-2.5">
          <PreviewToolbar
            mode={tools ? 'overlay' : sameOrigin ? 'same-origin' : html ? 'none' : 'loading'}
            session={session}
            active={activeTool}
            onTool={onTool}
            showComments={showComments}
            onShowComments={() => setShowComments((s) => !s)}
            openCount={comments.open.length}
            island={island}
            onIsland={() => setIsland((o) => !o)}
            chipCount={chips.length}
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
