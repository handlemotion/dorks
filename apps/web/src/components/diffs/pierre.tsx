import type { ComponentProps } from 'react'
import { File as PierreFile, MultiFileDiff as PierreMultiFileDiff, PatchDiff as PierrePatchDiff, WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { EditProvider } from '@pierre/diffs/react'
import { Editor, type EditorFactory } from '@pierre/diffs/edit'

// Pierre's highlighting off the main thread: a diff paints as plain text at once and its colours follow from a worker, so a PR with
// dozens of files no longer blocks the page while it is highlighted. Small diffs stay on the main thread (a worker round trip costs
// more). The pool is Pierre's singleton: every diff's provider shares it, and it stops when the last diff unmounts.
const POOL = { workerFactory: () => new DiffsWorker(), poolSize: 2, mainThreadMaxCharacters: 4000 }
const HIGHLIGHTER = {}

/** `pool: false` draws it on the main thread with its own options (the pool's worker fixes some, such as `lineDiffType`, for every diff). */
export function PatchDiff({ pool = true, ...props }: ComponentProps<typeof PierrePatchDiff> & { pool?: boolean }) {
  if (!pool) return <PierrePatchDiff {...props} />
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <PierrePatchDiff {...props} />
    </WorkerPoolContextProvider>
  )
}

export function File(props: ComponentProps<typeof PierreFile>) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <PierreFile {...props} />
    </WorkerPoolContextProvider>
  )
}

/** Pierre's editor for whatever `File` below asks for one (`edit`): plain, with its own find and undo. */
const createEditor: EditorFactory<undefined, undefined> = (type, options, key) => new Editor(type, options, key)

/** A file open for editing (the Files tab): `File` in an edit session. */
export function FileEditor(props: ComponentProps<typeof PierreFile>) {
  return (
    <EditProvider createEditor={createEditor}>
      <PierreFile edit {...props} />
    </EditProvider>
  )
}

export function MultiFileDiff(props: ComponentProps<typeof PierreMultiFileDiff>) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <PierreMultiFileDiff {...props} />
    </WorkerPoolContextProvider>
  )
}
