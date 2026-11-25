import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIcon, FolderTreeIcon, GitPullRequestIcon, LayersIcon, MonitorIcon, PanelLeftIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { ComputerView } from './ComputerView'
import { preloadDiffs } from './diffs'
import { BAR_BUTTON, PreviewBrowser, useShownServers, type PreviewSession } from './PreviewBrowser'
import { Tip } from './Tip'
import { EmptyState } from './EmptyState'
import { ProgressPanel } from './ProgressPanel'
import { useProgress } from '../lib/progress'
import { PullRequestPanel, TAB_CLASS, type PrStackEntry, type PullRequestPanelData } from './PullRequestPanel'
import { PrIcon, type PrStatusState } from './PrStatus'
import { Artifacts } from './chat-details/Artifacts'
import { NewTab } from './chat-details/NewTab'
import { sessionPrs, stackOf, stackRoot } from './chat-details/prStack'
import { PANEL_LABEL, type ChatDetailsData, type Panel, type TabKey } from './chat-details/types'
import { useOpenTabs } from './chat-details/useOpenTabs'

const PANEL_ICON: Record<Panel, ReactNode> = { progress: <ActivityIcon />, artifacts: <LayersIcon />, changes: <GitPullRequestIcon />, files: <FolderTreeIcon />, computer: <MonitorIcon /> }
/** The Files tab (Pierre's tree and editor) loads when it is first opened. */
const Files = lazy(() => import('./chat-details/Files'))

/**
 * Chat details: the right side of a chat, full height and flush to the window's edge, split from the chat by one full-height hairline
 * (the resize handle sits on it). Its top bar is 40px, placed so its labels share the chat title's centre line (24px from the top),
 * and holds the open tabs like a browser: Progress, Artifacts, Changes, Computer and one per pull request, in any order, each closable
 * (its icon turns into an X on hover, nothing moves), then "+" for a New tab, an index of the session's pull requests, artifacts and
 * panels. The open tabs and the selected one are remembered per session. The hide button keeps ShowDetailsButton's spot.
 */
/**
 * The last Progress reveal a panel acted on, kept outside the component so a remount (hide and show, another session) does not
 * replay an old reveal over the restored tabs, while a card that opens the panel still brings Progress up.
 */
let handledReveal = 0

export function ChatDetails({
  data,
  sessionId,
  onClose,
  onGrab,
  onAsk,
  previewSession,
  className,
}: {
  /** The session a running preview's comments and messages belong to (absent in the dev demo). */ previewSession?: PreviewSession
  data: ChatDetailsData
  /** Whose open tabs to remember. Without it they last as long as the panel. */ sessionId?: string
  onClose?: () => void
  /** An element picked in a running preview, as agent context. */ onGrab?: (snippet: string) => void
  /** An empty state's action: puts a ready request in the composer. */ onAsk?: (text: string) => void
  className?: string
}) {
  const tabs = useOpenTabs(sessionId)
  const { open } = tabs
  // The diff code is not part of the app's start; fetch it once the page is idle, before a PR or an edit is opened.
  useEffect(preloadDiffs, [])
  // A turn's card in the thread asks for its work: bring Progress up (also when the card opened this panel).
  const { reveal } = useProgress()
  useEffect(() => {
    if (reveal !== handledReveal) open('progress')
    handledReveal = reveal
  }, [reveal, open])
  const changes = data.changes ?? []
  const view = data.pullRequest?.view
  const headline = data.pr?.url
  // Every pull request the session has, stacked ones under the PR whose branch they build on.
  const prs = sessionPrs(data)
  // The agent just opened a pull request: bring its tab up. A chat that opens with one already open keeps the tab the owner was on.
  const seenHeadline = useRef(headline)
  useEffect(() => {
    if (headline && headline !== seenHeadline.current) open(`pr:${headline}`)
    seenHeadline.current = headline
  }, [headline, open])
  // Every PR the agent opens or subscribes to gets its tab (its own PRs are subscribed automatically), once: the session remembers
  // which PRs had theirs, so one added while this panel was closed or another chat was in front opens when the panel shows.
  const subscribed = data.subscriptions
  const { openNewPrs } = tabs
  useEffect(() => {
    if (subscribed) openNewPrs(subscribed.map((s) => s.url))
  }, [subscribed, openNewPrs])
  // A stack's PRs share one tab, named for the stack, showing whichever of its PRs was opened last; before paint, so three tabs
  // never flash up for a stack the agent just opened.
  const { collapse } = tabs
  const stackKey = prs.map((p) => `${p.url}<${p.parent ?? ''}`).join(' ')
  useLayoutEffect(() => {
    collapse((key) => (key.startsWith('pr:') ? stackRoot(prs, key.slice(3)) : undefined))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prs is rebuilt every render; stackKey is its shape
  }, [stackKey, tabs.keys, collapse])
  // The local diff's tab becomes the PR once there is one (tabs remembered from before PRs had their own).
  const { keys, replace } = tabs
  useEffect(() => {
    if (headline && keys.includes('changes')) replace('changes', `pr:${headline}`)
  }, [headline, keys, replace])
  // The first time the agent reaches for its computer while the chat is open, show its screen; a chat that opens on a computer
  // already used keeps the tab the owner was on.
  const used = data.computer?.used ?? false
  const wasUsed = useRef(used)
  useEffect(() => {
    if (used && !wasUsed.current) open('computer')
    wasUsed.current = used
  }, [used, open])
  // The preview open in Artifacts, by URL. The agent just showed a dev server: bring Artifacts up with it open. Held here, since the
  // tab's content unmounts while hidden.
  const [preview, setPreview] = useState<string>()
  const openPreview = data.previews?.find((s) => s.url === preview)
  useShownServers(data.previews, (s) => {
    open('artifacts')
    setPreview(s.url)
  })

  const label = (key: TabKey): { icon: ReactNode; text: ReactNode; title: string } => {
    if (key.startsWith('new:')) return { icon: <SearchIcon />, text: 'New tab', title: 'New tab' }
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const pr = prs.find((p) => p.url === url)
      const number = pr?.number ?? Number(/\/pull\/(\d+)/.exec(url)?.[1])
      const text = number ? `#${number}` : 'Pull request'
      const stack = stackOf(prs, url)
      if (stack) {
        const root = stack[0].number ? `#${stack[0].number}` : ''
        const name = `Stack ${root}`.trim()
        return {
          icon: <PrIcon state={pr?.state} draft={pr?.draft} />,
          text: <span className="tabular-nums">{name}</span>,
          title: `${name}: ${stack.map((p) => (p.number ? `#${p.number}` : 'PR')).join(', ')}`,
        }
      }
      return { icon: <PrIcon state={pr?.state} draft={pr?.draft} />, text: <span className="tabular-nums">{text}</span>, title: pr?.title ?? text }
    }
    const panel = key as Panel
    return { icon: PANEL_ICON[panel], text: PANEL_LABEL[panel], title: PANEL_LABEL[panel] }
  }
  const openPr = (url: string) => open(`pr:${url}`)

  const panel = (key: TabKey) => {
    if (key.startsWith('new:'))
      return (
        <NewTab
          prs={prs}
          artifacts={data.artifacts ?? []}
          previews={data.previews ?? []}
          hidePanel={(p) => p === 'changes' && prs.length > 0}
          panelLabel={(p) => PANEL_LABEL[p]}
          panelIcon={(p) => PANEL_ICON[p]}
          onOpen={(target) => tabs.replace(key, target)}
          onOpenPreview={(s) => {
            setPreview(s.url)
            tabs.replace(key, 'artifacts')
          }}
        />
      )
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const isHeadline = url === headline || view?.url === url
      const listed = prs.find((p) => p.url === url)
      return (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isHeadline ? (
            <PullRequestPanel changes={changes} pr={data.pr} pullRequest={data.pullRequest} stack={stackOf(prs, url)} onOpenPr={openPr} onAsk={onAsk} />
          ) : (
            <OtherPr url={url} state={listed?.state} usePr={data.usePullRequest} stack={stackOf(prs, url)} onOpenPr={openPr} onAsk={onAsk} />
          )}
        </div>
      )
    }
    switch (key as Panel) {
      case 'progress':
        return <ProgressPanel turns={data.progress ?? []} tasks={data.tasks} />
      case 'artifacts':
        return openPreview ? (
          <PreviewBrowser server={openPreview} onBack={() => setPreview(undefined)} onGrab={onGrab} session={previewSession} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <Artifacts
              artifacts={data.artifacts ?? []}
              changes={changes}
              previews={data.previews ?? []}
              onOpenChanges={() => open(headline ? `pr:${headline}` : 'changes')}
              onOpenPreview={(s) => setPreview(s.url)}
              onAsk={onAsk}
            />
          </div>
        )
      case 'changes':
        return (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PullRequestPanel changes={changes} pr={data.pr} pullRequest={data.pullRequest} onAsk={onAsk} />
          </div>
        )
      case 'files':
        return data.workspace ? (
          <Suspense>
            <Files source={data.workspace} />
          </Suspense>
        ) : (
          <EmptyState figure="cabinet" title="No sandbox files here" />
        )
      case 'computer':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ComputerView source={data.computer} />
          </div>
        )
    }
  }

  return (
    <>
      <aside
        aria-label="Chat details"
        data-details-panel
        className={['flex h-full min-h-0 min-w-0 flex-col border-l border-border [--details-edge:10px] [--details-text:18px]', className].filter(Boolean).join(' ')}
      >
        <Tabs value={tabs.selected} onValueChange={(value) => tabs.select(value as TabKey)} className="min-h-0 min-w-0 flex-1 gap-0">
          {/* 48px, matching PageHeader: labels sit on the chat title's 24px line and the bottom hairline meets the chat header's. */}
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
                <Button variant="ghost" size="icon-sm" className={`shrink-0 ${ACTION} size-7!`} aria-label="New tab" onClick={tabs.add}>
                  <PlusIcon />
                </Button>
              </Tip>
            </TabsList>
            {onClose && (
              <Tip label="Hide chat details">
                <Button variant="ghost" size="icon-sm" className={`ml-auto shrink-0 ${ACTION} size-7!`} aria-label="Hide chat details" onClick={onClose}>
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
    </>
  )
}

/**
 * An open tab: the same 28px box selected or not (nothing moves), a grey fill when selected, a lighter one on hover. On hover (or
 * keyboard focus) its icon gives way to an X in the same spot that closes it; a middle click closes it too.
 */
function OpenTab({ value, icon, title, onClose, children }: { value: TabKey; icon: ReactNode; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="group/tab relative flex-none">
      <TabsTrigger
        value={value}
        title={title}
        className={`${TAB_CLASS} max-w-48 group-hover/tab:text-foreground dark:group-hover/tab:text-foreground group-hover/tab:not-data-active:bg-foreground/[0.04]`}
        onAuxClick={(e) => {
          if (e.button === 1) onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <span className="flex shrink-0 group-hover/tab:invisible group-has-[button:focus-visible]/tab:invisible">{icon}</span>
        <span className="truncate">{children}</span>
      </TabsTrigger>
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="absolute top-1/2 left-[6px] flex size-[18px] -translate-y-1/2 items-center justify-center rounded-[4px] text-muted-foreground opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

/** A PR of the session other than its headline: read live through the host's hook when there is one. */
function OtherPr({
  url,
  state,
  usePr,
  stack,
  onOpenPr,
  onAsk,
}: {
  url: string
  state?: PrStatusState
  usePr?: (url: string) => PullRequestPanelData | undefined
  stack?: PrStackEntry[]
  onOpenPr: (url: string) => void
  onAsk?: (text: string) => void
}) {
  const live = usePr?.(url)
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined
  return <PullRequestPanel changes={[]} pr={{ url, number, state }} pullRequest={live} stack={stack} onOpenPr={onOpenPr} onAsk={onAsk} />
}

/** The hide/show buttons: 30px, like the tabs, with the tabs' hover. */
const ACTION = BAR_BUTTON
