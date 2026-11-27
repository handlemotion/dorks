import { createContext, useContext, useSyncExternalStore } from 'react'
import { ArrowUpRightIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import type { PreviewServer } from './PreviewBrowser'

// A running preview in the thread: where the agent called `preview_show`, a card with the page itself, scaled down like a screenshot,
// and a rail along its bottom with the app's name and a button that opens it in Chat details' Artifacts (or a new tab where there is
// no panel: a worker in a dork's panel, a narrow window).

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

/** The card for a `preview_show` call with this input; null when the session no longer lists a preview on that port. */
export function PreviewCard({ input }: { input?: Record<string, unknown> }) {
  const { servers, onOpen } = useContext(ShownPreviews)
  const server = servers.find((s) => s.port !== undefined && s.port === input?.port)
  if (!server) return null
  return (
    <section
      aria-label={`Preview: ${server.name}`}
      data-testid="preview-card"
      className="relative my-1.5 aspect-[16/10] w-full max-w-md overflow-hidden rounded-[6px] border border-surface-line bg-white"
    >
      {/* The live page at 2.5× the card's width, scaled down, so it reads like a desktop window. It takes no pointer or focus. */}
      <iframe
        src={server.html ? undefined : server.url}
        srcDoc={server.html}
        title={`${server.name} preview`}
        tabIndex={-1}
        aria-hidden
        loading="lazy"
        className="pointer-events-none absolute top-0 left-0 h-[250%] w-[250%] origin-top-left scale-40 border-0"
      />
      <div className="absolute inset-x-1.5 bottom-1.5 flex h-8 items-center gap-2 rounded-[8px] border bg-background pr-0.5 pl-2.5">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 truncate text-xs text-foreground" title={server.name}>
          {server.name}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-muted-foreground hover:text-foreground"
          aria-label={`Open ${server.name}`}
          onClick={() => (onOpen ? onOpen(server.url) : window.open(server.url, '_blank', 'noopener'))}
        >
          <ArrowUpRightIcon />
        </Button>
      </div>
    </section>
  )
}
