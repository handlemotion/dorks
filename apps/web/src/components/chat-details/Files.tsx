import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTheme } from 'next-themes'
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, GitBranchIcon, LoaderIcon } from 'lucide-react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { WorkspaceFile, WorkspaceRoot, WorkspaceTree } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { EmptyState } from '../EmptyState'
import { FileEditor } from '../diffs'

// The Files tab of Chat details: the repositories checked out in the session's sandbox, browsed and edited in place. Pierre's editor
// on the left, Pierre's file tree on the right under the repository chooser (when the sandbox holds more than one: a build's
// repositories, or one the agent cloned). Saves go straight to the sandbox and are refused when the agent changed the file since it
// was opened (the owner then reloads or overwrites). Unsaved edits are kept per file while the tab is open.

/** A failed read, as the panel needs it: the server's code picks the empty state. */
type Failure = { code?: string; message: string }
type Read<T> = { data?: T; error?: Failure }

/** Where the panel reads and writes: the server through the client, or the dev demo's memory. */
export type WorkspaceSource = {
  useRoots: () => Read<{ roots: WorkspaceRoot[] }>
  useTree: (root: string) => Read<WorkspaceTree>
  read: (root: string, path: string) => Promise<WorkspaceFile>
  write: (root: string, path: string, contents: string, sha?: string) => Promise<{ sha: string }>
  /** Lists the repositories and their files again. */
  refresh: () => void
}

/** How often the tree is listed again while the tab shows, so files the agent adds or changes appear. */
const REFRESH_MS = 15_000

export default function Files({ source }: { source: WorkspaceSource }) {
  const roots = source.useRoots()
  const list = roots.data?.roots
  const [chosen, setChosen] = useState<string>()
  // Unsaved edits by repository and path, kept here so switching repositories does not drop them.
  const drafts = useRef(new Map<string, Map<string, Doc>>())
  const { refresh } = source
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [refresh])
  if (!list) {
    if (!roots.error) return null
    if (roots.error.code === 'sleeping') return <EmptyState figure="laptop" title="Sandbox asleep" description="Its files show here while it is awake." />
    return (
      <EmptyState figure="relay" title="Couldn't load files" description={roots.error.message}>
        <Button size="sm" variant="outline" onClick={refresh}>
          Try again
        </Button>
      </EmptyState>
    )
  }
  if (!list.length) return <EmptyState figure="drawer" title="No repositories yet" description="Repositories cloned into the sandbox show up here." />
  const root = list.find((r) => r.id === chosen) ?? list.find((r) => r.primary) ?? list[0]!
  let docs = drafts.current.get(root.id)
  if (!docs) drafts.current.set(root.id, (docs = new Map()))
  return <Workspace key={root.id} source={source} root={root} roots={list} onRoot={setChosen} docs={docs} />
}

/** A file open in the editor: the version on disk it came from and the text being edited. */
type Doc = { file: Extract<WorkspaceFile, { kind: 'text' }>; draft: string; /** Bumped to start the editor again from `file`. */ version: number }
type Open = { path: string; state: 'loading' } | { path: string; state: 'text'; doc: Doc } | { path: string; state: 'other'; file: WorkspaceFile } | { path: string; state: 'error'; message: string }
type Save = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'conflict' } | { state: 'error'; message: string }

const failure = (e: unknown): Failure => ({ code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : 'Something went wrong' })

function Workspace({ source, root, roots, onRoot, docs: kept }: { source: WorkspaceSource; root: WorkspaceRoot; roots: WorkspaceRoot[]; onRoot: (id: string) => void; docs: Map<string, Doc> }) {
  const tree = source.useTree(root.id)
  const [open, setOpen] = useState<Open>()
  // Each file's save outcome, by path: a save that ends after another file was opened stays with its own file.
  const [saves, setSaves] = useState<Record<string, Save>>({})
  const setSave = (path: string, s: Save) => setSaves((all) => ({ ...all, [path]: s }))
  const save: Save = (open && saves[open.path]) || { state: 'idle' }
  // Unsaved edits by path, kept when another file is opened so coming back finds them.
  const docs = useRef(kept)
  const current = open?.state === 'text' ? open.doc : undefined
  const [, rerender] = useState(0)
  const dirty = !!current && current.draft !== current.file.contents

  const load = useCallback(
    async (path: string, fresh = false) => {
      setSave(path, { state: 'idle' })
      const kept = !fresh && docs.current.get(path)
      if (kept) return setOpen({ path, state: 'text', doc: kept })
      setOpen({ path, state: 'loading' })
      try {
        const file = await source.read(root.id, path)
        const prev = docs.current.get(path)
        if (file.kind !== 'text') return setOpen((o) => (o?.path === path ? { path, state: 'other', file } : o))
        const doc: Doc = { file, draft: file.contents, version: (prev?.version ?? 0) + 1 }
        docs.current.set(path, doc)
        setOpen((o) => (o?.path === path ? { path, state: 'text', doc } : o))
      } catch (e) {
        setOpen((o) => (o?.path === path ? { path, state: 'error', message: failure(e).message } : o))
      }
    },
    [source, root.id],
  )

  const write = async (force: boolean) => {
    const doc = current
    if (!doc || !open) return
    const path = open.path
    const text = doc.draft
    setSave(path, { state: 'saving' })
    try {
      const r = await source.write(root.id, path, text, force ? undefined : doc.file.sha)
      doc.file = { ...doc.file, contents: text, sha: r.sha, size: new Blob([text]).size }
      setSave(path, { state: 'saved' })
      rerender((n) => n + 1)
    } catch (e) {
      const f = failure(e)
      setSave(path, f.code === 'conflict' ? { state: 'conflict' } : { state: 'error', message: f.message })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilesSplit
        editor={
          <div className="flex h-full min-w-0 flex-col">
            <EditorBar
              path={open?.path}
              dirty={dirty}
              save={save}
              canSave={!!current}
              onSave={() => void write(false)}
              onOverwrite={() => void write(true)}
              onReload={() => open && void load(open.path, true)}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <EditorBody
                open={open}
                onChange={(text) => {
                  if (!current) return
                  const was = current.draft !== current.file.contents
                  current.draft = text
                  if (was !== (text !== current.file.contents)) rerender((n) => n + 1)
                  if (save.state === 'saved' && open) setSave(open.path, { state: 'idle' })
                }}
                onSave={() => void write(false)}
              />
            </div>
          </div>
        }
        tree={
          <div className="flex h-full min-w-0 flex-col">
            <RootChooser root={root} roots={roots} onRoot={onRoot} />
            <Tree tree={tree} selected={open?.path} onOpen={(p) => void load(p)} />
          </div>
        }
      />
    </div>
  )
}

const TREE_SIZE = '34%'

/** The editor and the tree side by side, the tree on the right; the split is remembered like every panel. */
function FilesSplit({ editor, tree }: { editor: React.ReactNode; tree: React.ReactNode }) {
  const layout = useDefaultLayout({ id: 'dorks.files-split.v1', storage: localStorage })
  const treePanel = usePanelRef()
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel id="editor" minSize={240}>
        {editor}
      </ResizablePanel>
      <PanelResizeHandle aria-label="Resize editor and files" side="end" className="w-px bg-border" onReset={() => treePanel.current?.resize(TREE_SIZE)} />
      <ResizablePanel id="tree" panelRef={treePanel} defaultSize={TREE_SIZE} minSize={180}>
        {tree}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** The open file's path (directory muted), whether it has unsaved edits, and Save. */
function EditorBar({
  path,
  dirty,
  save,
  canSave,
  onSave,
  onOverwrite,
  onReload,
}: {
  path?: string
  dirty: boolean
  save: Save
  canSave: boolean
  onSave: () => void
  onOverwrite: () => void
  onReload: () => void
}) {
  const slash = path?.lastIndexOf('/') ?? -1
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-(--details-text)">
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
        {path ? (
          <>
            <span className="text-muted-foreground">{slash >= 0 ? path.slice(0, slash + 1) : ''}</span>
            {path.slice(slash + 1)}
          </>
        ) : null}
      </span>
      {save.state === 'conflict' ? (
        <>
          <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">Changed in the sandbox</span>
          <Button size="xs" variant="outline" onClick={onReload}>
            Reload
          </Button>
          <Button size="xs" variant="outline" onClick={onOverwrite}>
            Overwrite
          </Button>
        </>
      ) : (
        <>
          {save.state === 'error' && (
            <span className="flex min-w-0 shrink items-center gap-1 truncate text-xs text-red-600 dark:text-red-400" title={save.message}>
              <CircleAlertIcon className="size-3.5 shrink-0" />
              <span className="truncate">{save.message}</span>
            </span>
          )}
          {save.state === 'saved' && !dirty && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5" />
              Saved
            </span>
          )}
          {canSave && (
            <Button size="xs" variant="outline" disabled={!dirty || save.state === 'saving'} onClick={onSave} title="Save (⌘S)">
              {save.state === 'saving' && <LoaderIcon className="animate-spin" />}
              Save
            </Button>
          )}
        </>
      )}
    </div>
  )
}

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function EditorBody({ open, onChange, onSave }: { open?: Open; onChange: (text: string) => void; onSave: () => void }) {
  const { resolvedTheme } = useTheme()
  const options = useMemo(
    () => ({ disableFileHeader: true, overflow: 'scroll' as const, useTokenTransformer: true, themeType: (resolvedTheme === 'dark' ? 'dark' : 'light') as 'dark' | 'light' }),
    [resolvedTheme],
  )
  if (!open) return <EmptyState figure="cabinet" title="No file open" description="Pick a file on the right to read or edit it." />
  if (open.state === 'loading') return null
  if (open.state === 'error') return <EmptyState figure="relay" title="Couldn't open this file" description={open.message} />
  if (open.state === 'other')
    return (
      <EmptyState
        figure="cabinet"
        title="Can't edit this file here"
        description={open.file.kind === 'binary' ? `It is a binary file (${human(open.file.size)}).` : `It is ${human(open.file.size)}; files up to 1 MB open here.`}
      />
    )
  const { doc } = open
  return (
    <div
      className="min-h-full [--diffs-bg:var(--background)] [--diffs-font-family:var(--font-mono)] [--diffs-font-size:12px] [--diffs-line-height:20px]"
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onSave()
        }
      }}
    >
      <FileEditor
        key={`${open.path}:${doc.version}`}
        file={{ name: open.path, contents: doc.draft, cacheKey: `${doc.file.sha}:${doc.version}` }}
        options={options}
        onEditChange={(e) => onChange(e.file.contents)}
        fallback={<pre className="px-4 py-2 font-mono text-xs leading-5 whitespace-pre">{doc.draft}</pre>}
      />
    </div>
  )
}

/** The repository the tree shows: a menu of the sandbox's checkouts when it holds more than one, else its name. */
function RootChooser({ root, roots, onRoot }: { root: WorkspaceRoot; roots: WorkspaceRoot[]; onRoot: (id: string) => void }) {
  const label = (
    <>
      <span className="max-w-[70%] min-w-0 shrink-0 truncate">{root.name}</span>
      {root.branch && (
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{root.branch}</span>
        </span>
      )}
    </>
  )
  if (roots.length < 2) return <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">{label}</div>
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border px-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 min-w-0 max-w-full justify-start gap-2 px-1.5 font-normal" aria-label="Choose a repository" />}>
          {label}
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Repositories in the sandbox</DropdownMenuLabel>
            {roots.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => onRoot(r.id)}>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {r.id === root.id && <CheckIcon />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The tree's look in the app's tokens: 13px rows, the selection's grey fill, git colours as in the PR's diff stats. */
const TREE_STYLE = {
  '--trees-bg-override': 'var(--background)',
  '--trees-fg-override': 'var(--foreground)',
  '--trees-fg-muted-override': 'var(--muted-foreground)',
  '--trees-selected-bg-override': 'color-mix(in oklab, var(--foreground) 7%, transparent)',
  '--trees-selected-fg-override': 'var(--foreground)',
  '--trees-border-color-override': 'var(--border)',
  '--trees-search-bg-override': 'color-mix(in oklab, var(--foreground) 4%, transparent)',
  '--trees-font-family-override': 'var(--font-sans)',
  '--trees-font-size-override': '13px',
  '--trees-border-radius-override': 'var(--control-radius)',
  '--trees-focus-ring-color-override': 'var(--ring)',
} as CSSProperties

/** Pierre's file tree of one checkout, with git's marks; picking a file opens it. */
function Tree({ tree, selected, onOpen }: { tree: Read<WorkspaceTree>; selected?: string; onOpen: (path: string) => void }) {
  const files = useMemo(() => new Set(tree.data?.paths ?? []), [tree.data?.paths])
  const latest = useRef({ files, onOpen, selected })
  latest.current = { files, onOpen, selected }
  const { model } = useFileTree({
    paths: [],
    search: true,
    flattenEmptyDirectories: true,
    initialExpansion: 'closed',
    // The search box would keep its intrinsic width and spill past a narrow panel.
    unsafeCSS: '[data-file-tree-search-container] input { min-width: 0; width: 0; }',
    onSelectionChange: (paths) => {
      const p = paths[paths.length - 1]
      const { files, onOpen, selected } = latest.current
      if (p && files.has(p) && p !== selected) onOpen(p)
    },
  })
  // A refresh lists every path again: apply only what changed, so folders stay open and the selection stays put.
  const paths = tree.data?.paths
  const shown = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!paths) return
    const before = shown.current
    const after = new Set(paths)
    shown.current = after
    if (!before) return model.resetPaths(paths)
    const gone = [...before].filter((p) => !after.has(p))
    const added = paths.filter((p) => !before.has(p))
    if (gone.length + added.length > 500) return model.resetPaths(paths)
    for (const p of gone) model.remove(p)
    for (const p of added) model.add(p)
  }, [model, paths])
  const status = tree.data?.status
  useEffect(() => {
    model.setGitStatus(status ?? [])
  }, [model, status])
  if (tree.error && !tree.data) return <p className="px-3 py-2 text-sm text-muted-foreground">{tree.error.message}</p>
  return (
    <>
      <FileTree model={model} className="min-h-0 flex-1" style={TREE_STYLE} />
      {tree.data?.truncated && <p className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground">Showing the first {tree.data.paths.length.toLocaleString()} files.</p>}
    </>
  )
}
