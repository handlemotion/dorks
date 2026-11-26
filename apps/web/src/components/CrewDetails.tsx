import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDork, useDorks, useDorksClient, usePullRequest } from '@dorks/client/react'
import { ArchiveIcon, LayersIcon, Maximize2Icon, PanelLeftIcon, PlusIcon, SearchIcon, SquareIcon, UsersIcon, XIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Tabs, TabsContent, TabsList } from '@dorks/ui/tabs'
import { toast } from 'sonner'
import { Artifacts } from './chat-details/Artifacts'
import { NewTab } from './chat-details/NewTab'
import type { IndexPr } from './chat-details/prStack'
import type { Artifact } from './chat-details/types'
import { useOpenTabs, type TabsConfig } from './chat-details/useOpenTabs'
import { EmptyState } from './EmptyState'
import { DorkIcon, dorkIconState } from './DorkIcon'
import { BAR_BUTTON, PreviewBrowser, type PreviewServer } from './PreviewBrowser'
import { PrIcon, prStatus } from './PrStatus'
import { PullRequestPanel, type PullRequestPanelData } from './PullRequestPanel'
import { OpenTab } from './ChatDetails'
import { SessionChat, type DorkView } from './SessionChat'
import { Tip } from './Tip'
import { setDraft } from '../lib/draft'
import { THUMB_WIDTH } from '../lib/images'

type Worker = NonNullable<ReturnType<typeof useDorks>>[number]
type CrewPanel = 'sessions' | 'artifacts'
/** An open tab: a panel, a worker's pull request (by url) or a New tab, as in Chat details. */
type CrewTabKey = CrewPanel | `pr:${string}` | `new:${string}`

const CREW_PANELS: CrewPanel[] = ['sessions', 'artifacts']
const CREW_LABEL: Record<CrewPanel, string> = { sessions: 'Sessions', artifacts: 'Artifacts' }
const CREW_ICON: Record<CrewPanel, ReactNode> = { sessions: <UsersIcon />, artifacts: <LayersIcon /> }
/** A dork opens its details on Sessions and Artifacts; each worker's PR gets its tab as it opens. Remembered per dork. */
const CREW_TABS: TabsConfig<CrewTabKey> = {
  storageKey: 'dorks.crew-details-tabs.',
  panels: CREW_PANELS,
  initial: () => ({ keys: ['sessions', 'artifacts'], selected: 'sessions' }),
}

const STATE_LABEL: Record<string, string> = { creating: 'Starting', working: 'Working', waking: 'Waking', idle: 'Done', sleeping: 'Asleep', error: 'Failed' }
const prNumber = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined
const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]

/** A dork's open worker, remembered per dork for the page's life (switching tabs or chats keeps it). */
const openWorker = new Map<string, string>()

/**
 * A dork's details (docs/crew.md): what its crew is doing, instead of one session's work. Tabs work as in Chat details (each closable,
 * "+" for a New tab, an index that reopens any of them), over the crew's own panels: Sessions (its workers; one opens in place, with
 * its own chat), Artifacts (everything the crew produced) and one tab per pull request a worker opened, the PR view alone (no local
 * changes: a dork writes no code). No Files or Computer: those are a coding session's. Same 48px bar and 6px tabs as Chat details.
 */
export function CrewDetails({ dork, onClose, onAsk }: { dork: DorkView; onClose?: () => void; onAsk?: (text: string) => void }) {
  const all = useDorks(false)
  const workers = (all ?? []).filter((d) => d.parentId === dork.id)
  const { actions } = useDorksClient()
  const tabs = useOpenTabs<CrewTabKey>(dork.id, CREW_TABS)
  // One per PR: two workers can hold the same PR (one picked up another's), and it gets one tab.
  const prs: IndexPr[] = []
  for (const w of workers) if (w.prUrl && !prs.some((p) => p.url === w.prUrl)) prs.push({ url: w.prUrl, title: w.title, repo: repoOf(w.prUrl), number: prNumber(w.prUrl), state: w.prState, depth: 0 })
  const workerOf = (url: string) => workers.find((w) => w.prUrl === url)
  // Every PR a worker opens gets its tab, once: one the owner closed stays closed, and opens again from a New tab.
  const prKey = prs.map((p) => p.url).join(' ')
  const { openNewPrs } = tabs
  useEffect(() => {
    if (all !== undefined) openNewPrs(prKey ? prKey.split(' ') : [])
  }, [all, prKey, openNewPrs])
  const [open, setOpenState] = useState<string | undefined>(() => openWorker.get(dork.id))
  const setOpen = (id: string | undefined) => {
    if (id) openWorker.set(dork.id, id)
    else openWorker.delete(dork.id)
    setOpenState(id)
  }
  const [preview, setPreview] = useState<string>()
  const { artifacts, previews } = crewArtifacts(dork, workers, actions.imageUrl)

  const label = (key: CrewTabKey): { icon: ReactNode; text: ReactNode; title: string } => {
    if (key.startsWith('new:')) return { icon: <SearchIcon />, text: 'New tab', title: 'New tab' }
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const worker = workerOf(url)
      const number = prNumber(url)
      const text = number ? `#${number}` : 'Pull request'
      return { icon: <PrIcon state={worker?.prState} />, text: <span className="tabular-nums">{text}</span>, title: worker?.title ?? text }
    }
    const panel = key as CrewPanel
    if (panel === 'sessions')
      return {
        icon: CREW_ICON.sessions,
        text: (
          <>
            Sessions
            {workers.length > 0 && <span className="ml-1.5 text-muted-foreground tabular-nums">{workers.length}</span>}
          </>
        ),
        title: 'Sessions',
      }
    return { icon: CREW_ICON[panel], text: CREW_LABEL[panel], title: CREW_LABEL[panel] }
  }

  const panel = (key: CrewTabKey) => {
    if (key.startsWith('new:'))
      return (
        <NewTab
          prs={prs}
          artifacts={artifacts}
          previews={previews}
          panels={CREW_PANELS}
          panelLabel={(p) => CREW_LABEL[p]}
          panelIcon={(p) => CREW_ICON[p]}
          onOpen={(target) => tabs.replace(key, target)}
          onOpenPreview={(s) => {
            setPreview(s.url)
            tabs.replace(key, 'artifacts')
          }}
        />
      )
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const worker = workerOf(url)
      // A worker that moved on to another PR, or was archived: the PR's link, without a live read.
      if (!worker)
        return (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PullRequestPanel changes={[]} pr={{ url, number: prNumber(url) }} />
          </div>
        )
      return (
        <WorkerPr
          worker={worker}
          onAsk={(text) => {
            // The PR's next step ("Resolve conflicts", "Fix checks") is for the worker that owns it: its composer, opened in place.
            setDraft(worker.id, text)
            setOpen(worker.id)
            tabs.open('sessions')
          }}
        />
      )
    }
    if (key === 'artifacts') {
      const shown = previews.find((p) => p.url === preview)
      if (shown) return <PreviewBrowser server={shown} onBack={() => setPreview(undefined)} />
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Artifacts artifacts={artifacts} changes={[]} previews={previews} onOpenChanges={() => {}} onOpenPreview={(s) => setPreview(s.url)} />
        </div>
      )
    }
    return open && workers.some((w) => w.id === open) ? (
      <WorkerPanel id={open} dork={dork} onClose={() => setOpen(undefined)} />
    ) : (
      <Sessions workers={workers} loading={all === undefined} onOpen={setOpen} onAsk={onAsk} />
    )
  }

  return (
    <aside aria-label="Dork details" data-details-panel className="flex h-full min-h-0 min-w-0 flex-col border-l border-border [--details-edge:10px] [--details-text:18px]">
      <Tabs value={tabs.selected} onValueChange={(v) => tabs.select(v as CrewTabKey)} className="min-h-0 min-w-0 flex-1 gap-0">
        {/* 48px, matching PageHeader and ChatDetails: labels sit on the chat title's 24px line and the bottom hairline meets the chat header's. */}
        <div data-tauri-drag-region className="flex h-12 min-w-0 shrink-0 items-center gap-0.5 border-b border-border px-(--details-edge)">
          <TabsList className="h-7! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            {tabs.keys.map((key) => {
              const { icon, text, title } = label(key)
              return (
                <OpenTab key={key} value={key} icon={icon} title={title} onClose={() => tabs.close(key)}>
                  {text}
                </OpenTab>
              )
            })}
            <Tip label="New tab">
              <Button variant="ghost" size="icon-sm" className={`shrink-0 ${BAR_BUTTON} size-7!`} aria-label="New tab" onClick={tabs.add}>
                <PlusIcon />
              </Button>
            </Tip>
          </TabsList>
          {onClose && (
            <Tip label="Hide dork details">
              <Button variant="ghost" size="icon-sm" className={`ml-auto shrink-0 ${BAR_BUTTON} size-7!`} aria-label="Hide dork details" onClick={onClose}>
                <PanelLeftIcon className="rotate-180" />
              </Button>
            </Tip>
          )}
        </div>
        {tabs.keys.map((key) => (
          <TabsContent key={key} value={key} className="flex min-h-0 flex-col">
            {panel(key)}
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
function crewArtifacts(dork: DorkView, workers: Worker[], imageUrl: (id: string, width?: number) => string): { artifacts: Artifact[]; previews: PreviewServer[] } {
  const sessions = [dork, ...workers]
  const artifacts: Artifact[] = sessions.flatMap((s) =>
    (s.images ?? []).map((i, n) => ({
      id: i.id,
      // Comments are the session's own: only the dork's screenshots take them here (a worker's do on its own page).
      ...(s.id === dork.id ? { imageId: i.id } : {}),
      name: `${s.title} · ${i.caption ?? `Screenshot ${n + 1}`}`,
      type: 'Screenshot',
      src: imageUrl(i.id),
      thumb: imageUrl(i.id, THUMB_WIDTH),
      width: i.width,
      height: i.height,
    })),
  )
  const previews: PreviewServer[] = sessions.flatMap((s) => (s.previews ?? []).map((p) => ({ name: `${s.title} · ${p.title ?? `Port ${p.port}`}`, url: p.url, port: p.port })))
  return { artifacts, previews }
}

/** A worker's pull request, read live from GitHub as in Chat details, with its merge and branch update. No local changes. Its asks ("Resolve conflicts") go to the worker. */
function WorkerPr({ worker, onAsk }: { worker: Worker; onAsk: (text: string) => void }) {
  const { actions } = useDorksClient()
  const url = worker.prUrl
  // Read by URL: the worker's headline moves to each PR it opens, and a read cached for its previous one must not show under this tab.
  const pr = usePullRequest(worker.id, url)
  useEffect(() => {
    if (url) actions.refreshPullRequest(worker.id)
  }, [actions, worker.id, url])
  const refresh = useCallback(() => actions.refreshPullRequest(worker.id), [actions, worker.id])
  if (!url) return null
  const data: PullRequestPanelData = {
    view: pr.data,
    error: pr.error?.message,
    refresh,
    merge: async (method, sha) => void (await actions.mergePullRequest(worker.id, method, sha, url)),
    updateBranch: (sha) => actions.updatePullRequestBranch(worker.id, sha, url),
    markReady: () => actions.markPullRequestReady(worker.id, url),
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PullRequestPanel changes={[]} pr={{ url, number: prNumber(url), state: worker.prState }} pullRequest={data} onAsk={onAsk} />
    </div>
  )
}
