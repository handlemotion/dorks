import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CommentAnchor } from '@dorks/shared'

// The app's side of the preview overlay (infra/bridge/overlay/overlay.ts, docs/architecture.md "Preview proxy"): the page in the
// frame is on another origin, so everything that needs its DOM is asked for over postMessage, and every answer is checked to come
// from this frame's window. Commands go to the preview's origin only.

export type Rect = { x: number; y: number; width: number; height: number }
export type HoverBox = Rect & { radius: string; label: string }
export type Mark = { id: string; kind: 'element' | 'text'; path: string; selector: string; quote?: string; prefix?: string; suffix?: string }
export type PickMode = 'element' | 'text'
/** A picked element or passage: its anchor, where it is in the frame, and (for an element) React Grab's snippet. */
export type Picked = { anchor: CommentAnchor; box: Rect; snippet?: string }

type FromOverlay = {
  dorks?: unknown
  type?: unknown
  path?: unknown
  box?: HoverBox | Rect | null
  snippet?: unknown
  anchor?: CommentAnchor
  on?: unknown
  marks?: { id: string; rects: Rect[] | null }[]
  id?: unknown
  data?: unknown
  error?: unknown
}

export function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

/**
 * Talks to the overlay in `frame`. `ready` turns true once the page answers (a page without the overlay never does);
 * `onPicked` gets each element or passage picked in the page.
 */
export function useOverlay(frame: RefObject<HTMLIFrameElement | null>, url: string, reloads: number, onPicked: (p: Picked) => void) {
  const [ready, setReady] = useState(false)
  const [path, setPath] = useState('/')
  const [hover, setHover] = useState<HoverBox | null>(null)
  const [picking, setPicking] = useState<PickMode | null>(null)
  const [rects, setRects] = useState<Map<string, Rect[] | null>>(new Map())
  const captures = useRef(new Map<string, { resolve: (data: string) => void; reject: (e: Error) => void }>())
  const picked = useRef(onPicked)
  picked.current = onPicked
  const origin = originOf(url)

  const post = useCallback((m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ dorks: 'host', ...m }, origin), [frame, origin])

  useEffect(() => {
    setReady(false)
    setPicking(null)
    setHover(null)
    setRects(new Map())
  }, [url, reloads])

  useEffect(() => {
    const settle = (d: FromOverlay) => {
      const waiting = typeof d.id === 'string' ? captures.current.get(d.id) : undefined
      if (!waiting) return
      captures.current.delete(d.id as string)
      if (typeof d.data === 'string') waiting.resolve(d.data)
      else waiting.reject(new Error(typeof d.error === 'string' ? d.error : 'capture failed'))
    }
    const onPick = (d: FromOverlay) => {
      setHover(null)
      if (d.anchor && d.box) picked.current({ anchor: d.anchor, box: d.box as Rect, ...(typeof d.snippet === 'string' ? { snippet: d.snippet } : {}) })
    }
    const handlers: Record<string, (d: FromOverlay) => void> = {
      ready: (d) => {
        setReady(true)
        if (typeof d.path === 'string') setPath(d.path)
      },
      location: (d) => typeof d.path === 'string' && setPath(d.path),
      hover: (d) => setHover((d.box as HoverBox | null) ?? null),
      picking: (d) => d.on === false && setPicking(null),
      grab: onPick,
      selection: onPick,
      marks: (d) => Array.isArray(d.marks) && setRects(new Map(d.marks.map((m) => [m.id, m.rects]))),
      captured: settle,
    }
    const onMessage = (e: MessageEvent) => {
      const d = e.data as FromOverlay | null
      if (!d || d.dorks !== 'overlay' || !frame.current || e.source !== frame.current.contentWindow) return
      if (typeof d.type === 'string') handlers[d.type]?.(d)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frame])

  // Escape in the app ends picking too (the page has its own).
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])
  useEffect(() => {
    if (ready) post(picking ? { type: 'pick', on: true, mode: picking } : { type: 'pick', on: false })
    if (!picking) setHover(null)
  }, [ready, picking, post])

  return {
    ready,
    path,
    hover,
    picking,
    rects,
    /** Asks the page to say it is there (after a load: its first "ready" may have come before this listener). */
    hello: () => post({ type: 'hello' }),
    pick: (mode: PickMode | null) => setPicking(mode),
    setMarks: (marks: Mark[]) => post({ type: 'marks', marks }),
    reveal: (id: string) => post({ type: 'reveal', id }),
    /** The area `rect` of the frame's viewport as a PNG data URL. */
    capture: (rect: Rect) =>
      new Promise<string>((resolve, reject) => {
        const id = Math.random().toString(36).slice(2)
        captures.current.set(id, { resolve, reject })
        post({ type: 'capture', id, rect })
        setTimeout(() => {
          if (captures.current.delete(id)) reject(new Error('The page did not answer.'))
        }, 15_000)
      }),
  }
}

export type Overlay = ReturnType<typeof useOverlay>
