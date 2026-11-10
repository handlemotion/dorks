import { useState, type ReactNode } from 'react'
import { ExternalLinkIcon, GitPullRequestIcon, GlobeIcon, LayersIcon, PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { PreviewBrowser } from './PreviewBrowser'

/** A file the agent produced in the chat: a screenshot, a design, a document. */
export type Artifact = { id: string; name: string; /** Short type label, e.g. "PNG". */ type: string; src?: string; href?: string }
export type FileChange = { path: string; additions: number; deletions: number }

/** Everything Chat details can show. Missing parts show an empty state in their tab. */
export type ChatDetailsData = {
  artifacts?: Artifact[]
  changes?: FileChange[]
  pr?: { url: string; number?: number }
  previewUrl?: string
  /** An inline page for the Browser tab instead of a URL (same-origin, so the element picker works); the dev demo uses it. */
  previewHtml?: string
}

type Tab = 'artifacts' | 'changes' | 'browser'

/**
 * Chat details: the one raised surface in the app (`bg-surface`, white in light), on the right of a chat. Its tabs sit above it like
 * browser tabs: the active one takes the surface's fill and joins it through two concave corners, the others are plain labels on the
 * app fill. The tabs are fixed (always the same three, in the same order).
 */
export function ChatDetails({ data, onClose, onGrab, className }: { data: ChatDetailsData; onClose?: () => void; /** An element picked in the Browser tab, as agent context. */ onGrab?: (snippet: string) => void; className?: string }) {
  const [tab, setTab] = useState<Tab>('artifacts')
  const changes = data.changes ?? []
  return (
    <aside aria-label="Chat details" className={['flex min-h-0 flex-col pr-2 pb-2 pl-2', className].filter(Boolean).join(' ')}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-h-0 flex-1 gap-0">
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-end">
          <TabsList className="h-9! gap-0.5 rounded-none bg-transparent p-0">
            <DetailsTab value="artifacts" icon={<LayersIcon />} first>Artifacts</DetailsTab>
            <DetailsTab value="changes" icon={<GitPullRequestIcon />} count={changes.length || undefined}>Changes</DetailsTab>
            <DetailsTab value="browser" icon={<GlobeIcon />}>Browser</DetailsTab>
          </TabsList>
          {onClose && (
            <Button variant="ghost" size="icon-sm" className="mb-1 ml-auto text-muted-foreground" aria-label="Hide chat details" title="Hide chat details" onClick={onClose}>
              <PanelRightCloseIcon />
            </Button>
          )}
        </div>
        {/* The first tab sits flush with this surface's left edge: while it is active, the two share one straight side. */}
        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--control-radius) bg-surface ${tab === 'artifacts' ? 'rounded-tl-none' : ''}`}>
          <TabsContent value="artifacts" className="flex min-h-0 flex-col overflow-y-auto">
            <Artifacts artifacts={data.artifacts ?? []} changes={changes} onOpenChanges={() => setTab('changes')} />
          </TabsContent>
          <TabsContent value="changes" className="min-h-0 overflow-y-auto">
            <Changes changes={changes} pr={data.pr} />
          </TabsContent>
          <TabsContent value="browser" className="flex min-h-0 flex-col">
            <PreviewBrowser url={data.previewUrl} html={data.previewHtml} onGrab={onGrab} />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  )
}

/** The concave corner that joins the active tab to the surface below it, drawn in the surface's fill. */
// 7px, not 6: each piece overlaps the tab and the surface by 1px so no anti-aliased seam shows where they meet.
const corner = 'pointer-events-none absolute -bottom-px hidden size-[7px] in-data-active:block'

/**
 * Every tab has the same 36px box (8-44px, its bottom on the surface's top), selected or not, so nothing moves when the selection
 * changes. The selected tab fills it in the surface colour and its concave corners join it to the surface. Hover shares the box's
 * top edge and is inset 4px on the sides and bottom (8-40px, centred on the chat title, like the label). The 2px gap plus that inset
 * leaves room for the selected tab's 6px corners.
 */
function DetailsTab({ value, icon, count, first, children }: { value: Tab; icon: ReactNode; count?: number; first?: boolean; children: ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="h-9 flex-none gap-1.5 rounded-none rounded-t-(--control-radius) isolate px-3 pt-0 pb-1 transition-none text-sm font-normal text-muted-foreground hover:text-foreground data-active:bg-surface dark:data-active:bg-surface [&_svg:not([class*='size-'])]:size-3.5"
    >
      <span aria-hidden className="absolute inset-x-1 top-0 bottom-1 -z-10 rounded-(--control-radius) transition-colors in-[[data-slot=tabs-trigger]:hover:not([data-active])]:bg-foreground/[0.06]" />
      {icon}
      {children}
      {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
      {!first && <span aria-hidden className={`${corner} -left-1.5 bg-[radial-gradient(circle_at_0_0,transparent_6px,var(--surface)_6.5px)]`} />}
      <span aria-hidden className={`${corner} -right-1.5 bg-[radial-gradient(circle_at_100%_0,transparent_6px,var(--surface)_6.5px)]`} />
    </TabsTrigger>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">{children}</p>
}

const sum = (changes: FileChange[], key: 'additions' | 'deletions') => changes.reduce((n, c) => n + c[key], 0)

function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{' '}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

/**
 * A grid of tiles split by full hairlines (each tile draws its right and bottom edge; the grid hides only the outer right one, so the last row keeps its bottom line). The first tile
 * is the code changes, when there are any.
 */
function Artifacts({ artifacts, changes, onOpenChanges }: { artifacts: Artifact[]; changes: FileChange[]; onOpenChanges: () => void }) {
  if (artifacts.length === 0 && changes.length === 0) return <EmptyState>Screenshots, designs and files from this chat show up here.</EmptyState>
  return (
    <div className="@container overflow-hidden">
      <ul className="-mr-px grid grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-4">
        {changes.length > 0 && (
          <Tile onClick={onOpenChanges} thumb={<DiffThumb />} label={<Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} />} meta={`${changes.length} files`}>
            Code changes
          </Tile>
        )}
        {artifacts.map((a) => (
          <Tile key={a.id} href={a.href ?? a.src} thumb={a.src ? <img src={a.src} alt="" className="size-full object-cover" /> : null} label={a.type}>
            {a.name}
          </Tile>
        ))}
      </ul>
    </div>
  )
}

function Tile({ thumb, label, meta, href, onClick, children }: { thumb: ReactNode; label: ReactNode; meta?: string; href?: string; onClick?: () => void; children: string }) {
  const body = (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-[8px] bg-app">{thumb}</div>
      <div className="mt-3.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        {label}
        {meta && <span className="tabular-nums">{meta}</span>}
      </div>
      <div className="mt-1 truncate text-sm" title={children}>{children}</div>
    </>
  )
  const cls = 'block w-full px-5 pt-5 pb-4 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
  return (
    <li className="border-r border-b">
      {onClick ? <button type="button" className={cls} onClick={onClick}>{body}</button> : href ? <a className={cls} href={href} target="_blank" rel="noreferrer">{body}</a> : <div className={cls}>{body}</div>}
    </li>
  )
}

/** A few diff lines, drawn: the code-changes tile's thumbnail. */
function DiffThumb() {
  const rows = ['w-1/2 bg-foreground/10', 'w-3/4 bg-red-500/70', 'w-2/3 bg-emerald-500/70', 'w-4/5 bg-emerald-500/70', 'w-1/2 bg-emerald-500/70', 'w-3/5 bg-foreground/10']
  return (
    <div className="flex size-full flex-col justify-center gap-1.5 px-[18%]">
      {rows.map((r, i) => <div key={i} className={`h-1.5 rounded-full ${r}`} />)}
    </div>
  )
}

function Changes({ changes, pr }: { changes: FileChange[]; pr?: ChatDetailsData['pr'] }) {
  return (
    <div className="flex min-h-full flex-col text-sm">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        {pr ? (
          <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline">
            <span className="truncate">{pr.number ? `Pull request #${pr.number}` : 'Pull request'}</span>
            <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-muted-foreground">No pull request yet</span>
        )}
        {changes.length > 0 && <span className="ml-auto text-xs"><Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} /></span>}
      </div>
      {changes.length === 0 ? (
        <EmptyState>The agent has not changed any files yet.</EmptyState>
      ) : (
        <ul className="divide-y">
          {changes.map((c) => {
            const slash = c.path.lastIndexOf('/')
            return (
              <li key={c.path} className="flex h-9 items-center gap-3 px-4 font-mono text-xs">
                <span className="min-w-0 flex-1 truncate" title={c.path}>
                  <span className="text-muted-foreground">{c.path.slice(0, slash + 1)}</span>
                  {c.path.slice(slash + 1)}
                </span>
                <Stat additions={c.additions} deletions={c.deletions} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const OPEN_KEY = 'dorks.chat-details-open'

/** Whether Chat details is shown beside a chat, remembered per browser. Open by default. */
export function useDetailsOpen() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0' } catch { return true }
  })
  const set = (next: boolean) => {
    setOpen(next)
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0') } catch { /* private mode: keep it in memory */ }
  }
  return [open, set] as const
}

/** The chat header's button that brings Chat details back. Wide windows only, like the panel itself. */
export function ShowDetailsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" className="hidden text-muted-foreground lg:inline-flex" aria-label="Show chat details" title="Show chat details" onClick={onClick}>
      <PanelRightOpenIcon />
    </Button>
  )
}

/** Chat details' width beside the chat: half of it, hidden on narrow ones. */
export const DETAILS_WIDTH = 'hidden w-1/2 min-w-[26rem] max-w-[60rem] shrink-0 lg:flex'
