import { useEffect, useLayoutEffect, useRef } from 'react'
import { BrowserHost } from '@effect/ui/html'
import { Effect, Fiber } from 'effect'
import type { Island, IslandMessage } from './island'

type Root<P, E> = { readonly send: (message: IslandMessage<P, E>) => void }

/**
 * Mounts an Effect UI island (island.ts) into a `display: contents` div that React renders and never fills, so the island's markup lays
 * out as if it were React's own. The island mounts once per `island`; new props are sent to it, and its events call `onEvent`.
 * Unmounting interrupts the mount, which closes its scope and removes its nodes. Popups (Select, Menu, Dialog) render in the
 * browser's top layer, so they need no portal and escape React's overflow.
 */
export function EffectIsland<P, E>({ island, props, onEvent }: { island: Island<P, E>; props: P; onEvent?: (event: E) => void }) {
  const node = useRef<HTMLDivElement>(null)
  const root = useRef<Root<P, E> | undefined>(undefined)
  const latest = useRef({ props, onEvent })
  latest.current = { props, onEvent }

  useLayoutEffect(() => {
    const container = node.current
    if (!container) return
    const mounted = latest.current.props
    const program = BrowserHost.mountEffect(island.component, mounted, container, {
      // React's document owns the head.
      head: false,
      onEmit: (event) => latest.current.onEvent?.(event as E),
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          root.current = r
          // Props that changed while the mount started.
          if (latest.current.props !== mounted) r.send(island.receivedProps(latest.current.props))
        }),
      ),
      Effect.andThen(Effect.never),
      Effect.scoped,
    )
    const fiber = Effect.runFork(program)
    return () => {
      root.current = undefined
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [island])

  // Props are Schema data: compare them by value, so a React re-render with equal props sends nothing.
  const key = JSON.stringify(props)
  useEffect(() => {
    root.current?.send(island.receivedProps(latest.current.props))
  }, [island, key])

  return <div ref={node} className="contents" />
}
