import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ExternalLinkIcon, RotateCwIcon, SquareMousePointerIcon } from 'lucide-react'
import { Button, buttonVariants } from '@dorks/ui/button'
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

/**
 * A running preview, opened from its Artifacts tile: what the agent showed with `preview_show` (a dev server, hosted by the box
 * provider), under a bar with Back (to the artifacts), Reload, the server's name, the element picker and Open in a new tab. There is
 * no address bar: the agent has its own Chrome (the Computer tab) for browsing.
 *
 * The picker uses React Grab's primitives (`react-grab/primitives`, loaded on first use) on the preview's own document: hovering
 * highlights the element under the pointer, clicking hands its context (the same snippet React Grab copies: markup, component and source location) to `onGrab`, and
 * Escape leaves. Reaching into the frame's document needs it to be same-origin, so the picker only shows for a same-origin preview.
 */
export function PreviewBrowser({ server, onBack, onGrab }: { server: PreviewServer; onBack: () => void; onGrab?: (snippet: string) => void }) {
  const current = server.url
  const [reloads, setReloads] = useState(0)
  const [sameOrigin, setSameOrigin] = useState(false)
  const [picking, setPicking] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const grab = useRef<Primitives | null>(null)
  const html = server.html

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
  }, [current, reloads])
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
        <Tip label="All artifacts">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="All artifacts" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <Tip label="Reload">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Reload" onClick={() => setReloads((n) => n + 1)}>
            <RotateCwIcon />
          </Button>
        </Tip>
        <p className="mx-2 flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="truncate">{server.name}</span>
          <span className="shrink-0 text-muted-foreground">{server.port ? `:${server.port}` : port(server.url)}</span>
        </p>
        {sameOrigin && (
          <Tip label={picking ? 'Stop selecting (Esc)' : 'Select an element to send to the agent'}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`${BAR_BUTTON} aria-pressed:bg-brand/10 aria-pressed:text-brand`}
              aria-label="Select an element"
              aria-pressed={picking}
              onClick={() => void startPicking()}
            >
              <SquareMousePointerIcon />
            </Button>
          </Tip>
        )}
        {!html && (
          <Tip label="Open in a new tab">
            <a href={current} target="_blank" rel="noreferrer" aria-label="Open in a new tab" className={`${buttonVariants({ variant: 'ghost', size: 'icon-sm' })} ${BAR_BUTTON}`}>
              <ExternalLinkIcon />
            </a>
          </Tip>
        )}
      </div>
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
          <div className="pointer-events-none absolute border border-brand bg-brand/10" style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: box.radius }}>
            <span className={`absolute left-0 rounded-(--control-radius) ${box.y < 28 ? 'top-0 m-1' : 'bottom-full mb-1'} bg-brand px-1.5 py-0.5 font-mono text-xs text-white`}>{box.label}</span>
          </div>
        )}
      </div>
    </>
  )
}
