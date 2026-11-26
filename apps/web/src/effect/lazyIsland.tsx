import { lazy, Suspense } from 'react'
import type { Island } from './island'

/**
 * A React component that renders an island (island.ts) from a chunk of its own: Effect, @effect/ui and the ported component load the
 * first time it renders, so they stay out of the app's entry chunk. Call it once at module level with a dynamic import of the island
 * (`lazyIsland(() => import('../../effect/islands').then((m) => m.AppearancePageIsland))`); nothing in the React tree should import
 * src/effect at runtime except through this. Nothing shows while the chunk loads.
 */
export function lazyIsland<P, E>(load: () => Promise<Island<P, E>>) {
  const Loaded = lazy(async () => {
    const [{ EffectIsland }, island] = await Promise.all([import('./EffectIsland'), load()])
    return { default: (slot: { props: P; onEvent?: (event: E) => void }) => <EffectIsland island={island} {...slot} /> }
  })
  return function IslandSlot(slot: { props: P; onEvent?: (event: E) => void }) {
    return (
      <Suspense fallback={null}>
        <Loaded {...slot} />
      </Suspense>
    )
  }
}
