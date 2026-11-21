import type { ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

// Pierre's highlighting off the main thread: a diff paints as plain text at once and its colours follow from a worker, so a PR with
// dozens of files no longer blocks the page while it is highlighted. Small diffs stay on the main thread (a worker round trip costs
// more). The pool starts when Chat details mounts, so it is warm before a PR's Files tab opens.
const POOL = { workerFactory: () => new DiffsWorker(), poolSize: 2, mainThreadMaxCharacters: 4000 }
const HIGHLIGHTER = {}

export function DiffWorkers({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      {children}
    </WorkerPoolContextProvider>
  )
}
