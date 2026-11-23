import { lazy, Suspense, type ComponentProps } from 'react'
import type { MultiFileDiff as PierreMultiFileDiff, PatchDiff as PierrePatchDiff } from '@pierre/diffs/react'

// Pierre (diffs, its Shiki highlighter and worker) is most of the app's code by weight and only draws diffs: it loads on its own, after
// the app is up (`preloadDiffs`), not with it, so starting the app and opening a chat do not wait for it.
const load = () => import('./pierre')
const LazyPatchDiff = lazy(() => load().then((m) => ({ default: m.PatchDiff })))
const LazyMultiFileDiff = lazy(() => load().then((m) => ({ default: m.MultiFileDiff })))

/** Fetches the diff code while the page is idle, so the first diff opened is drawn at once. */
export function preloadDiffs() {
  const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200))
  idle(() => void load())
}

export function PatchDiff(props: ComponentProps<typeof PierrePatchDiff>) {
  return (
    <Suspense>
      <LazyPatchDiff {...props} />
    </Suspense>
  )
}

export function MultiFileDiff(props: ComponentProps<typeof PierreMultiFileDiff>) {
  return (
    <Suspense>
      <LazyMultiFileDiff {...props} />
    </Suspense>
  )
}
