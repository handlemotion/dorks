import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, SquareMousePointerIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'

type Primitives = typeof import('react-grab/primitives')
type Box = { x: number; y: number; width: number; height: number; radius: string; label: string }

/** `localhost:5173` and `example.com` become full URLs; anything with a scheme is kept. */
function normalize(input: string) {
  const v = input.trim()
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v)) return v
  return /^(localhost|127\.|\[::1\])/.test(v) ? `http://${v}` : `https://${v}`
}

/**
 * The Browser tab: back, forward, reload, the address and the element picker over a preview frame.
 *
 * The picker uses React Grab's primitives (`react-grab/primitives`, loaded on first use) on the preview's own document: hovering
 * highlights the element under the pointer, clicking hands its context (the same snippet React Grab copies: markup, component and source location) to `onGrab`, and
 * Escape leaves. Reaching into the frame's document needs it to be same-origin, so the picker is off for a cross-origin preview.
 * `html` renders an inline (same-origin) page instead of a URL; the dev demo uses it.
 */
export function PreviewBrowser({ url: initialUrl, html, onGrab }: { url?: string; html?: string; onGrab?: (snippet: string) => void }) {
  const [history, setHistory] = useState<string[]>(initialUrl ? [initialUrl] : [])
  const [index, setIndex] = useState(initialUrl ? 0 : -1)
  const [address, setAddress] = useState(initialUrl ?? '')
  const [reloads, setReloads] = useState(0)
  const [sameOrigin, setSameOrigin] = useState(false)
  const [picking, setPicking] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const grab = useRef<Primitives | null>(null)
  const current = history[index]

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
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b px-2">
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Back" title="Back" disabled={index <= 0} onClick={() => go(index - 1)}>
          <ArrowLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Forward" title="Forward" disabled={index >= history.length - 1} onClick={() => go(index + 1)}>
          <ArrowRightIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Reload" title="Reload" disabled={!current && !html} onClick={() => setReloads((n) => n + 1)}>
          <RotateCwIcon />
        </Button>
        <form
          className="mx-1.5 min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
          }}
        >
          <Input aria-label="Address" placeholder="Type a URL" value={address} onChange={(e) => setAddress(e.target.value)} className="h-7 text-sm" spellCheck={false} />
        </form>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground aria-pressed:bg-brand/10 aria-pressed:text-brand"
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
      ) : (
        <p className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">When the agent runs a dev server, its preview opens here.</p>
      )}
    </>
  )
}
