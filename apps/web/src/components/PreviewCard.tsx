import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { originOf } from './preview/useOverlay'
import type { PreviewServer } from './PreviewBrowser'

// A running preview in the thread: where the agent called `preview_show` (its tool line, "Opened a preview", says so above), the page
// itself, scaled down like a screenshot, with one button that opens it in Chat details' Artifacts (or a new tab where there is no
// panel: a worker in a dork's panel, a narrow window). The button takes the contrast of the page's fill: black on a light page,
// white on a dark one.

/** The session's running previews (`dork.previews`) and how the thread opens one. */
export const ShownPreviews = createContext<{ servers: PreviewServer[]; onOpen?: (url: string) => void }>({ servers: [] })

/** The thread asked Chat details to open a preview: bumped per ask, so the panel can act on one it mounts after (it was hidden). */
let request = { n: 0, url: '' }
const listeners = new Set<() => void>()
export function requestPreview(url: string) {
  request = { n: request.n + 1, url }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const usePreviewRequest = () =>
  useSyncExternalStore(
    subscribe,
    () => request,
    () => request,
  )

export const isPreviewShow = (name: string) => name === 'mcp__dorks__preview_show'

/** Whether a CSS color (`rgb(…)`/`rgba(…)`, as computed styles give it) is light: relative luminance over 0.5; undefined when unread. */
export function isLight(color: string): boolean | undefined {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color)
  if (!m) return undefined
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [m[1], m[2], m[3]].map((c) => lin(Number(c)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
}

/**
 * The page's fill as light or dark. An inline page (the dev demo) is read directly; a hosted one says it through the overlay the
 * bridge's preview proxy adds (its `ready` message carries `bg`). Undefined until known, or on a bridge too old to say.
 */
function usePageLight(frame: React.RefObject<HTMLIFrameElement | null>, server: PreviewServer) {
  const [light, setLight] = useState<boolean>()
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { dorks?: string; type?: string; bg?: unknown } | null
      if (e.source !== frame.current?.contentWindow || d?.dorks !== 'overlay' || d.type !== 'ready' || typeof d.bg !== 'string') return
      setLight(isLight(d.bg))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frame])
  const onLoad = () => {
    const el = frame.current
    if (!el) return
    if (server.html) {
      const doc = el.contentDocument
      const bg = doc && [doc.body, doc.documentElement].map((x) => (x ? getComputedStyle(x).backgroundColor : '')).find((c) => c && !/,\s*0\)$/.test(c) && c !== 'transparent')
      setLight(bg ? isLight(bg) : true)
    } else el.contentWindow?.postMessage({ dorks: 'host', type: 'hello' }, originOf(server.url))
  }
  return { light, onLoad }
}

/** The card for a `preview_show` call with this input; null when the session no longer lists a preview on that port. */
export function PreviewCard({ input }: { input?: Record<string, unknown> }) {
  const { servers, onOpen } = useContext(ShownPreviews)
  const server = servers.find((s) => s.port !== undefined && s.port === input?.port)
  const frame = useRef<HTMLIFrameElement>(null)
  const { light, onLoad } = usePageLight(frame, server ?? { name: '', url: 'about:blank' })
  if (!server) return null
  // Black on a light page; white with a hairline on a dark one, and while the fill is unknown.
  const button = light ? 'bg-neutral-950 text-white hover:bg-neutral-800' : 'border border-black/10 bg-white text-neutral-950 hover:bg-neutral-100'
  return (
    <section
      aria-label={`Preview: ${server.name}`}
      data-testid="preview-card"
      data-page={light === undefined ? undefined : light ? 'light' : 'dark'}
      className="relative my-1.5 aspect-[16/10] w-full max-w-md overflow-hidden rounded-[6px] border border-surface-line bg-white"
    >
      {/* The live page at 2.5× the card's width, scaled down, so it reads like a desktop window. It takes no pointer or focus. */}
      <iframe
        ref={frame}
        src={server.html ? undefined : server.url}
        srcDoc={server.html}
        onLoad={onLoad}
        title={`${server.name} preview`}
        tabIndex={-1}
        aria-hidden
        loading="lazy"
        className="pointer-events-none absolute top-0 left-0 h-[250%] w-[250%] origin-top-left scale-40 border-0"
      />
      <button
        type="button"
        aria-label={`Open ${server.name}`}
        onClick={() => (onOpen ? onOpen(server.url) : window.open(server.url, '_blank', 'noopener'))}
        className={`absolute right-2 bottom-2 h-7 rounded-(--control-radius) px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${button}`}
      >
        Open
      </button>
    </section>
  )
}
