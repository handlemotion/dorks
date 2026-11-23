import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDork, useDorks, useDorksClient, usePullRequest } from '@dorks/client/react'
import { ArchiveIcon, LayersIcon, Maximize2Icon, PanelLeftIcon, SquareIcon, UsersIcon, XIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { toast } from 'sonner'
import { Artifacts } from './chat-details/Artifacts'
import type { Artifact } from './chat-details/types'
import { EmptyState } from './EmptyState'
import { DorkIcon, dorkIconState } from './DorkIcon'
import { BAR_BUTTON, PreviewBrowser, type PreviewServer } from './PreviewBrowser'
import { PrIcon, prStatus } from './PrStatus'
import { PullRequestPanel, TAB_CLASS, type PullRequestPanelData } from './PullRequestPanel'
import { SessionChat, type DorkView } from './SessionChat'
import { Tip } from './Tip'
import { THUMB_WIDTH } from '../lib/images'

type Worker = NonNullable<ReturnType<typeof useDorks>>[number]
type TabKey = 'sessions' | 'artifacts' | `pr:${string}`

const STATE_LABEL: Record<string, string> = { creating: 'Starting', working: 'Working', waking: 'Waking', idle: 'Done', sleeping: 'Asleep', error: 'Failed' }
const prNumber = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined

/** A dork's open worker, remembered per dork for the page's life (switching tabs or chats keeps it). */
const openWorker = new Map<string, string>()

/**
 * A dork's details (docs/crew.md): what its crew is doing, instead of one session's work. Tabs, browser-like as in Chat details but
 * fixed: Sessions (its workers; one opens in place, with its own chat), Artifacts (everything the crew produced) and one tab per pull
 * request a worker opened, the PR view alone (no local changes: a dork writes no code). Same 40px bar and 6px tabs as Chat details.
 */
export function CrewDetails({ dork, onClose, onAsk }: { dork: DorkView; onClose?: () => void; onAsk?: (text: string) => void }) {
  const all = useDorks(false)
  const workers = (all ?? []).filter((d) => d.parentId === dork.id)
  const prs = workers.flatMap((w) => (w.prUrl ? [{ worker: w, url: w.prUrl }] : []))
  const [tab, setTab] = useState<TabKey>('sessions')
  const [open, setOpenState] = useState<string | undefined>(() => openWorker.get(dork.id))
  const setOpen = (id: string | undefined) => {
    if (id) openWorker.set(dork.id, id)
    else openWorker.delete(dork.id)
    setOpenState(id)
  }
  // A PR tab whose worker went away (archived) falls back to Sessions.
  const selected: TabKey = tab.startsWith('pr:') && !prs.some((p) => `pr:${p.worker.id}` === tab) ? 'sessions' : tab
  return (
    <aside aria-label="Dork details" data-details-panel className="flex h-full min-h-0 min-w-0 flex-col border-l border-border [--details-edge:10px] [--details-text:18px]">
      <Tabs value={selected} onValueChange={(v) => setTab(v as TabKey)} className="min-h-0 min-w-0 flex-1 gap-0">
        {/* 48px, matching PageHeader and ChatDetails: labels sit on the chat title's 24px line and the bottom hairline meets the chat header's. */}
        <div data-tauri-drag-region className="flex h-12 min-w-0 shrink-0 items-center gap-0.5 border-b border-border px-(--details-edge)">
          <TabsList className="h-7! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            <TabsTrigger value="sessions" className={TAB_CLASS}>
              <UsersIcon />
              Sessions
              {workers.length > 0 && <span className="text-muted-foreground tabular-nums">{workers.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="artifacts" className={TAB_CLASS}>
              <LayersIcon />
              Artifacts
            </TabsTrigger>
            {prs.map(({ worker, url }) => (
              <TabsTrigger key={worker.id} value={`pr:${worker.id}`} className={TAB_CLASS} title={worker.title}>
                <PrIcon state={worker.prState} />
                <span className="tabular-nums">#{prNumber(url)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {onClose && (
            <Tip label="Hide dork details">
              <Button variant="ghost" size="icon-sm" className={`ml-auto shrink-0 ${BAR_BUTTON} size-7!`} aria-label="Hide dork details" onClick={onClose}>
                <PanelLeftIcon className="rotate-180" />
              </Button>
            </Tip>
          )}
        </div>
        <TabsContent value="sessions" className="flex min-h-0 flex-col">
          {open && workers.some((w) => w.id === open) ? (
            <WorkerPanel id={open} dork={dork} onClose={() => setOpen(undefined)} />
          ) : (
            <Sessions workers={workers} loading={all === undefined} onOpen={setOpen} onAsk={onAsk} />
          )}
        </TabsContent>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col">
          <CrewArtifacts dork={dork} workers={workers} />
        </TabsContent>
        {prs.map(({ worker }) => (
          <TabsContent key={worker.id} value={`pr:${worker.id}`} className="flex min-h-0 flex-col">
            <WorkerPr worker={worker} />
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  )
}

/** The dork's workers, newest activity first: state, title, repository and PR, then the start of their latest message. */
function Sessions({ workers, loading, onOpen, onAsk }: { workers: Worker[]; loading: boolean; onOpen: (id: string) => void; onAsk?: (text: string) => void }) {
  if (loading)
    return (
      <p role="status" className="px-(--details-text) text-sm text-muted-foreground">
        Loading sessions…
      </p>
    )
  if (!workers.length)
    return (
      <EmptyState figure="relay" title="No sessions yet" description="The sessions this dork starts for its goal show up here.">
        {onAsk && (
          <Button size="sm" variant="outline" onClick={() => onAsk('Plan the goal and start the sessions it needs.')}>
            Ask for a plan
          </Button>
        )}
      </EmptyState>
    )
  return (
    <ul aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto">
      {workers.map((w) => (
        <li key={w.id} className="border-b">
          <button
            type="button"
            onClick={() => onOpen(w.id)}
            className="flex w-full min-w-0 flex-col gap-1 p-(--details-text) text-left outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]"
          >
            <span className="flex w-full min-w-0 items-center gap-2 text-sm">
              <DorkIcon size={14} state={dorkIconState(w.state, { attention: w.needsAttention })} label={w.needsAttention ? 'Needs attention' : (STATE_LABEL[w.state] ?? w.state)} />
              <span className="min-w-0 flex-1 truncate">{w.title}</span>
              {w.prUrl && (
                <span data-pr={w.prState} className={`shrink-0 text-xs tabular-nums ${prStatus(w.prState).className}`}>
                  #{prNumber(w.prUrl)}
                </span>
              )}
            </span>
            <span className="flex w-full min-w-0 items-center gap-2 pl-[22px] text-xs text-muted-foreground">
              <span className="shrink-0">{STATE_LABEL[w.state] ?? w.state}</span>
              {w.repo && <span className="min-w-0 truncate">· {w.repo}</span>}
            </span>
            {w.preview && <span className="line-clamp-2 pl-[22px] text-xs text-muted-foreground">{w.preview}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * One worker open in place: a full-width bar (its state and title; open it full screen, stop its turn, archive it, close) and its chat
 * under it, which the owner can talk in like any other. Full screen is the worker's own page, with its own details and a crumb back here.
 */
function WorkerPanel({ id, dork, onClose }: { id: string; dork: DorkView; onClose: () => void }) {
  const worker = useDork(id)
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  if (!worker)
    return (
      <p role="status" className="px-(--details-text) text-sm text-muted-foreground">
        {worker === null ? 'That session is gone.' : 'Loading session…'}
      </p>
    )
  const working = worker.state === 'working'
  const act = (what: string, f: () => Promise<unknown>) => () => void f().catch((e: unknown) => toast.error(e instanceof Error ? e.message : `Could not ${what}`))
  return (
    <section aria-label={`Session ${worker.title}`} className="flex min-h-0 flex-1 flex-col" data-state={worker.state}>
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-0.5 border-b pr-(--details-edge) pl-(--details-text)">
        <DorkIcon
          size={14}
          state={dorkIconState(worker.state, { attention: worker.needsAttention })}
          label={worker.needsAttention ? 'Needs attention' : (STATE_LABEL[worker.state] ?? worker.state)}
          className="mr-2"
        />
        <span className="min-w-0 flex-1 truncate text-sm" title={worker.title}>
          {worker.title}
        </span>
        <BarAction label="Open full screen" onClick={() => void navigate({ to: '/dorks', search: { dork: worker.id } })}>
          <Maximize2Icon />
        </BarAction>
        {working && (
          <BarAction label="Stop" onClick={act('stop it', () => actions.interrupt(worker.id))}>
            <SquareIcon />
          </BarAction>
        )}
        {!worker.archived && (
          <BarAction
            label="Archive"
            onClick={act('archive it', async () => {
              await actions.archiveDork(worker.id, true)
              onClose()
            })}
          >
            <ArchiveIcon />
          </BarAction>
        )}
        <BarAction label={`Back to ${dork.title}'s sessions`} onClick={onClose}>
          <XIcon />
        </BarAction>
      </div>
      <SessionChat dork={worker} compact />
    </section>
  )
}

function BarAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon-sm" className={`shrink-0 ${BAR_BUTTON} size-7!`} aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </Tip>
  )
}

/** Everything the crew produced: the dork's and each worker's screenshots and running previews, named by the session they came from. */
function CrewArtifacts({ dork, workers }: { dork: DorkView; workers: Worker[] }) {
  const { actions } = useDorksClient()
  const [preview, setPreview] = useState<string>()
  const sessions = [dork, ...workers]
  const artifacts: Artifact[] = sessions.flatMap((s) =>
    (s.images ?? []).map((i, n) => ({
      id: i.id,
      name: `${s.title} · ${i.caption ?? `Screenshot ${n + 1}`}`,
      type: 'Screenshot',
      src: actions.imageUrl(i.id),
      thumb: actions.imageUrl(i.id, THUMB_WIDTH),
      width: i.width,
      height: i.height,
    })),
  )
  const previews: PreviewServer[] = sessions.flatMap((s) => (s.previews ?? []).map((p) => ({ name: `${s.title} · ${p.title ?? `Port ${p.port}`}`, url: p.url, port: p.port })))
  const open = previews.find((p) => p.url === preview)
  if (open) return <PreviewBrowser server={open} onBack={() => setPreview(undefined)} />
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Artifacts artifacts={artifacts} changes={[]} previews={previews} onOpenChanges={() => {}} onOpenPreview={(s) => setPreview(s.url)} />
    </div>
  )
}

/** A worker's pull request, read live from GitHub as in Chat details, with its merge and branch update. No local changes. */
function WorkerPr({ worker }: { worker: Worker }) {
  const { actions } = useDorksClient()
  const pr = usePullRequest(worker.id)
  const url = worker.prUrl
  useEffect(() => {
    if (url) actions.refreshPullRequest(worker.id)
  }, [actions, worker.id, url])
  const refresh = useCallback(() => actions.refreshPullRequest(worker.id), [actions, worker.id])
  if (!url) return null
  const data: PullRequestPanelData = {
    view: pr.data,
    error: pr.error?.message,
    refresh,
    merge: async (method, sha) => void (await actions.mergePullRequest(worker.id, method, sha)),
    updateBranch: (sha) => actions.updatePullRequestBranch(worker.id, sha),
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PullRequestPanel changes={[]} pr={{ url, number: prNumber(url), state: worker.prState }} pullRequest={data} />
    </div>
  )
}
