import { useCallback, useEffect, useState } from 'react'
import { ExternalLinkIcon, HandIcon, RotateCwIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { toAppError, type DesktopOptions } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { EmptyState } from './EmptyState'
import { BAR_BUTTON } from './PreviewBrowser'
import { Tip } from './Tip'

/** What the Computer tab needs from the chat: whether the box is awake, and how to mint a stream URL. */
export type ComputerSource = {
  /** The dork's box is running (`working` or `idle`): only then is there a screen to stream. */
  awake: boolean
  /** The agent is in a turn: taking over interrupts it first. */
  working: boolean
  /** The agent has driven the computer in this chat (a `mcp__computer__*` tool ran). */
  used: boolean
  /** A fresh live-view URL. It is a bearer credential with a 10-minute window: minted per view, never stored. */
  fetchUrl: (opts: DesktopOptions) => Promise<string>
  interrupt: () => Promise<void>
}

/**
 * The agent's own computer, live (docs/computer-use.md): Boat's desktop stream in an iframe. View-only by default, so the owner's
 * clicks never land between the agent's; Take over stops the turn and hands the pointer and keyboard over. A new URL is minted
 * whenever the theme or the box changes, and on Reload (Boat's URLs are single-use within 10 minutes).
 */
export function ComputerView({ source }: { source?: ComputerSource }) {
  const { resolvedTheme } = useTheme()
  const theme: DesktopOptions['theme'] = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [reloads, setReloads] = useState(0)
  const [control, setControl] = useState(false)
  /** The stream page has loaded in the frame. Boat's player is cross-origin and reports nothing more, so this is as live as we can tell. */
  const [loaded, setLoaded] = useState(false)
  const awake = source?.awake ?? false
  const fetchUrl = source?.fetchUrl

  useEffect(() => {
    setUrl(undefined)
    setError(undefined)
    setLoaded(false)
    if (!awake || !fetchUrl) {
      setControl(false)
      return
    }
    let live = true
    fetchUrl({ theme }).then(
      (u) => live && setUrl(u),
      (e) => live && setError(toAppError(e).message),
    )
    return () => {
      live = false
    }
  }, [awake, fetchUrl, theme, reloads])

  const takeOver = useCallback(async () => {
    if (control) return setControl(false)
    if (source?.working) await source.interrupt().catch(() => {})
    setControl(true)
  }, [control, source])

  if (!source || (!awake && !source.used)) {
    return <EmptyState figure="laptop" title="No computer in use" description="When the agent uses a computer, its screen shows here." />
  }
  if (!awake) return <EmptyState figure="laptop" title="Computer asleep" description="It wakes with your next message." />

  return (
    <>
      {error ? (
        <EmptyState figure="laptop" title="Couldn't show the screen" description={error}>
          <Button size="sm" variant="outline" onClick={() => setReloads((n) => n + 1)}>Try again</Button>
        </EmptyState>
      ) : url ? (
        // The screen keeps Boat's 16:9 (1920x1080) and floats in the panel's own fill with 24px around it: as wide as fits, never
        // taller than the space, centred. A size container so the frame can be sized from both the width and the height.
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 [container-type:size]">
          <iframe
            key={url}
            src={url}
            title="Agent's computer"
            allow="autoplay; fullscreen; clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            className={`aspect-video w-[min(100cqw,calc(100cqh*16/9))] rounded-(--control-radius) bg-surface ${control ? '' : 'pointer-events-none'}`}
            tabIndex={control ? 0 : -1}
            onLoad={() => setLoaded(true)}
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {/* Under the screen, like a player's controls: 30px buttons, the status dot on the same x as the tab icons. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-t pr-1 pl-[5px]">
        <StreamStatus state={error ? 'offline' : loaded ? 'live' : 'connecting'} />
        <Tip side="top" label={control ? 'Hand back control' : source.working ? 'Take over (stops the agent)' : 'Take over'}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={`${BAR_BUTTON} aria-pressed:bg-brand/10 aria-pressed:text-brand`}
            aria-label={control ? 'Hand back control' : 'Take over'}
            aria-pressed={control}
            disabled={!url}
            onClick={() => void takeOver()}
          >
            <HandIcon />
          </Button>
        </Tip>
        <Tip side="top" label="Reload">
          <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Reload" onClick={() => setReloads((n) => n + 1)}>
            <RotateCwIcon />
          </Button>
        </Tip>
        <Tip side="top" label="Open in a window">
          <Button
            variant="ghost"
            size="icon-sm"
            className={BAR_BUTTON}
            aria-label="Open in a window"
            disabled={!fetchUrl}
            onClick={() => {
              // A URL of its own: the one in the frame is already spent.
              void fetchUrl?.({ theme }).then((u) => window.open(u, '_blank', 'noopener,noreferrer'), () => {})
            }}
          >
            <ExternalLinkIcon />
          </Button>
        </Tip>
      </div>
    </>
  )
}

/** The stream's state, in the bar's empty start: a dot and a word, the dot centred under the tab icons above (14px icon at 14px). */
function StreamStatus({ state }: { state: 'connecting' | 'live' | 'offline' }) {
  const [dot, label] = {
    connecting: ['bg-muted-foreground/50', 'Connecting'],
    live: ['bg-emerald-500', 'Live'],
    offline: ['bg-destructive', 'Not connected'],
  }[state]
  return (
    <span className="mr-auto flex items-center gap-2 pr-2 pl-[13px] text-sm text-muted-foreground" role="status" aria-live="polite">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}
