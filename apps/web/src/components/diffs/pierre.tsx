import type { ComponentProps } from 'react'
import { MultiFileDiff as PierreMultiFileDiff, PatchDiff as PierrePatchDiff, WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

// Pierre's highlighting off the main thread: a diff paints as plain text at once and its colours follow from a worker, so a PR with
// dozens of files no longer blocks the page while it is highlighted. Small diffs stay on the main thread (a worker round trip costs
// more). The pool is Pierre's singleton: every diff's provider shares it, and it stops when the last diff unmounts.
const POOL = { workerFactory: () => new DiffsWorker(), poolSize: 2, mainThreadMaxCharacters: 4000 }
const HIGHLIGHTER = {}

export function PatchDiff(props: ComponentProps<typeof PierrePatchDiff>) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <PierrePatchDiff {...props} />
    </WorkerPoolContextProvider>
  )
}

export function MultiFileDiff(props: ComponentProps<typeof PierreMultiFileDiff>) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <PierreMultiFileDiff {...props} />
    </WorkerPoolContextProvider>
  )
}
