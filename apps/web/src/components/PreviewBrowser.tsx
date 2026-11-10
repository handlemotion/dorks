import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, GlobeIcon, RotateCwIcon, SquareMousePointerIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { EmptyState } from './EmptyState'
import { List } from './onboarding/List'

/** A dev server running in the sandbox. `html` renders an inline (same-origin) page instead of the URL; the dev demo uses it. */
export type PreviewServer = { name: string; url: string; html?: string; /** Overrides the page's own `/favicon.ico`. */ favicon?: string; /** Shown as `:3000`; a hosted preview's URL carries no port of its own. */ port?: number }

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

/** `localhost:5173` and `example.com` become full URLs; anything with a scheme is kept. */
function normalize(input: string) {
  const v = input.trim()
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v)) return v
  return /^(localhost|127\.|\[::1\])/.test(v) ? `http://${v}` : `https://${v}`
}

/** `http://localhost:5173` reads as `:5173`; a URL with no port keeps its host. */
function port(url: string) {
  try {
    const u = new URL(url)
    return u.port ? `:${u.port}` : u.host
  } catch {
    return url
  }
}

/** The page's favicon, a globe until it loads (or when the page has none). */
function Favicon({ server }: { server: PreviewServer }) {
  const [failed, setFailed] = useState(false)
  let src = server.favicon
  try {
    src ??= new URL('/favicon.ico', server.url).href
  } catch {
    // not a URL: keep the globe
  }
  if (!src || failed) return <GlobeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  return <img src={src} alt="" aria-hidden className="size-4 shrink-0 rounded-[3px] object-contain" onError={() => setFailed(true)} />
}

/**
 * The Browser tab: back, forward, reload, the address and the element picker over a preview frame. With no page open it lists the
 * sandbox's dev servers as an island of rows (the onboarding's `List`); a row opens its preview, and Back returns to the list.
 *
 * The picker uses React Grab's primitives (`react-grab/primitives`, loaded on first use) on the preview's own document: hovering
 * highlights the element under the pointer, clicking hands its context (the same snippet React Grab copies: markup, component and source location) to `onGrab`, and
 * Escape leaves. Reaching into the frame's document needs it to be same-origin, so the picker is off for a cross-origin preview.
 */
export function PreviewBrowser({ servers = [], open, onOpened, onGrab, onAsk }: { servers?: PreviewServer[]; /** A URL to open now (a server the agent just showed); `onOpened` clears it. */ open?: string; onOpened?: () => void; onGrab?: (snippet: string) => void; onAsk?: (text: string) => void }) {
  const [history, setHistory] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const [address, setAddress] = useState('')
  const [reloads, setReloads] = useState(0)
  const [sameOrigin, setSameOrigin] = useState(false)
  const [picking, setPicking] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const grab = useRef<Primitives | null>(null)
  const current = history[index]
  const html = current ? servers.find((s) => normalize(s.url) === current)?.html : undefined

  const go = (to: number) => {
    setIndex(to)
    setAddress(history[to] ?? '')
  }
  const navigate = (raw: string) => {
    const next = normalize(raw)
    if (!next) return
    setHistory((h) => [...h.slice(0, index + 1), next])
    setIndex(index + 1)
    setAddress(next)
  }
  useEffect(() => {
    if (!open) return
    navigate(open)
    onOpened?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per URL to open
  }, [open])

  // Picking listens inside the preview's document (capture phase, so the page never sees the click) and draws the highlight in this
  // document, over the frame. Escape in either document leaves; so does any change of page.
  useEffect(() => {
    const doc = frame.current?.contentDocument
    const g = grab.current
    if (!picking || !doc || !g) return
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
      setPicking(false)
      // The selector starts at this app's frame (`[title="Preview"] >>iframe>> …`); the agent only needs the part inside the page.
      void g.getElementContext(el).then((ctx) => onGrab?.(ctx.snippet.replace(/\S+ >>iframe>> /g, '')))
    }
    const block = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(false)
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
      doc.documentElement.style.cursor = cursor
      doc.removeEventListener('mousemove', onMove, true)
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('mousedown', block, true)
      doc.removeEventListener('mouseleave', onLeave)
      doc.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onKey)
    }
  }, [picking, onGrab])
  useEffect(() => {
    setPicking(false)
    setSameOrigin(false)
  }, [current, html, reloads])
  useEffect(() => {
    if (!picking) setBox(null)
  }, [picking])

  const startPicking = async () => {
    if (picking) return setPicking(false)
    grab.current ??= await import('react-grab/primitives')
    setPicking(true)
  }

  return (
    <>
      {/* Same rhythm as the tab row above: 30px buttons, icons in line with the tab icons and the hide button (measured: same left and right edges). */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-y pr-1 pl-[5px]">
        <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Back" title="Back" disabled={index < (servers.length ? 0 : 1)} onClick={() => go(index - 1)}>
          <ArrowLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Forward" title="Forward" disabled={index >= history.length - 1} onClick={() => go(index + 1)}>
          <ArrowRightIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Reload" title="Reload" disabled={!current && !html} onClick={() => setReloads((n) => n + 1)}>
          <RotateCwIcon />
        </Button>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
          }}
        >
          <Input aria-label="Address" placeholder="Type a URL" value={address} onChange={(e) => setAddress(e.target.value)} className="h-[30px] text-sm" spellCheck={false} />
        </form>
        <Button
          variant="ghost"
          size="icon-sm"
          className={`${BAR_BUTTON} aria-pressed:bg-brand/10 aria-pressed:text-brand`}
          aria-label="Select an element"
          aria-pressed={picking}
          title={sameOrigin ? 'Select an element (Esc to stop)' : 'Element selection needs a same-origin preview'}
          disabled={!sameOrigin}
          onClick={() => void startPicking()}
        >
          <SquareMousePointerIcon />
        </Button>
      </div>
      {current || html ? (
        <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
          <iframe
            key={`${current}:${reloads}`}
            ref={frame}
            src={html ? undefined : current}
            srcDoc={html}
            title="Preview"
            className="size-full bg-white"
            onLoad={() => {
              try {
                setSameOrigin(!!frame.current?.contentDocument)
              } catch {
                setSameOrigin(false)
              }
            }}
          />
          {box && (
            <div
              className="pointer-events-none absolute border border-brand bg-brand/10"
              style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: box.radius }}
            >
              <span className={`absolute left-0 rounded-(--control-radius) ${box.y < 28 ? 'top-0 m-1' : 'bottom-full mb-1'} bg-brand px-1.5 py-0.5 font-mono text-xs text-white`}>{box.label}</span>
            </div>
          )}
        </div>
      ) : servers.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto p-8">
          <section aria-label="Dev servers" className="mx-auto flex w-full max-w-sm flex-col gap-6">
            <h2 className="text-center text-sm font-medium">Running in the sandbox</h2>
            <List>
              {servers.map((s) => (
                <li key={s.url}>
                  <button type="button" className="group/row flex h-12 w-full items-center gap-3 px-4 text-left outline-none focus-visible:bg-muted" onClick={() => navigate(s.url)}>
                    <Favicon server={s} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="truncate text-muted-foreground transition-colors group-hover/row:text-foreground">{s.port ? `:${s.port}` : port(s.url)}</span>
                  </button>
                </li>
              ))}
            </List>
          </section>
        </div>
      ) : (
        <EmptyState figure="window" title="No preview yet" description="When the agent runs a dev server, its preview opens here. Or type a URL above.">
          {onAsk && <Button size="sm" variant="outline" onClick={() => onAsk('Start the dev server and tell me its URL so I can preview it.')}>Ask for a preview</Button>}
        </EmptyState>
      )}
    </>
  )
}
