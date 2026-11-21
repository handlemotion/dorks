import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { AppWindowIcon, FileIcon, MonitorIcon, SearchIcon } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@dorks/ui/input-group'
import type { ComputerSource } from '../ComputerView'
import { EmptyState } from '../EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from '../ImageLightbox'
import { port, type PreviewServer } from '../PreviewBrowser'
import { Stat } from '../PullRequestPanel'
import { PrIcon } from '../PrStatus'
import type { IndexPr } from './prStack'
import { PANEL_LABEL, PANELS, type Artifact, type Panel, type TabKey } from './types'

/** A 30px row in the New tab: an icon and a label, the hover fill of the bar's buttons. */
const INDEX_ROW =
  'flex h-[30px] w-full items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

/**
 * A New tab: an index of what the session holds. A search box filters the pull requests, artifacts and panels below by name; each
 * opens in this tab's place. Sections with nothing in them are left out.
 */
export function NewTab({
  prs,
  artifacts,
  previews,
  hidePanel,
  panelLabel,
  panelIcon,
  computer,
  computerOpen,
  onOpen,
  onOpenPreview,
}: {
  prs: IndexPr[]
  artifacts: Artifact[]
  previews: PreviewServer[]
  /** Panels another section already lists (the local diff, once the PRs have their own rows). */ hidePanel: (p: Panel) => boolean
  panelLabel: (p: Panel) => string
  panelIcon: (p: Panel) => ReactNode
  computer?: ComputerSource
  /** The Computer tab is open: its stream is the one live view, so the window here shows the state only. */ computerOpen: boolean
  onOpen: (target: TabKey) => void
  onOpenPreview: (server: PreviewServer) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const match = (...names: (string | undefined)[]) => !q || names.some((n) => n?.toLowerCase().includes(q))
  const manyRepos = new Set(prs.map((p) => p.repo)).size > 1
  const shownPrs = prs.filter((p) => match(p.title, p.repo, p.number ? `#${p.number}` : undefined))
  const shownPreviews = previews.filter((s) => match(s.name))
  const shownArtifacts = artifacts.filter((a) => (a.src || a.href) && match(a.name, a.type))
  const shownPanels = PANELS.filter((p) => !hidePanel(p) && match(PANEL_LABEL[p], panelLabel(p)))
  const images: LightboxImage[] = artifacts.filter((a) => a.src).map((a) => ({ id: a.id, src: a.src!, alt: a.name, caption: a.name, width: a.width, height: a.height }))
  const showComputer = !!computer?.used && match('Computer')
  const nothing = shownPrs.length + shownPreviews.length + shownArtifacts.length + shownPanels.length === 0 && !showComputer
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-6 px-5 pt-[20vh] pb-10">
        <InputGroup className="h-[30px] rounded-(--control-radius) border-border bg-transparent dark:bg-transparent">
          <InputGroupAddon className="pl-2">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            aria-label="Search pull requests, artifacts and tools"
            placeholder="Search PRs, artifacts and tools"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="text-sm"
          />
        </InputGroup>
        {showComputer && <ComputerWindow source={computer!} live={!computerOpen} onOpen={() => onOpen('computer')} />}
        {nothing && <EmptyState figure="drawer" title="No matches" />}
        {shownPrs.length > 0 && (
          <IndexSection title="Pull requests">
            {shownPrs.map((p) => (
              <li key={p.url}>
                <PrRow pr={p} showRepo={manyRepos} indent={!q} onOpen={() => onOpen(`pr:${p.url}`)} />
              </li>
            ))}
          </IndexSection>
        )}
        {shownPanels.length > 0 && (
          <IndexSection title="Tools">
            {shownPanels.map((p) => (
              <li key={p}>
                <button type="button" className={INDEX_ROW} onClick={() => onOpen(p)}>
                  {panelIcon(p)}
                  <span className="truncate">{panelLabel(p)}</span>
                </button>
              </li>
            ))}
          </IndexSection>
        )}
        {shownPreviews.length + shownArtifacts.length > 0 && (
          <ImageLightbox images={images} label="Artifacts">
            <IndexSection title="Artifacts">
              {shownPreviews.map((s) => (
                <li key={s.url}>
                  <button type="button" className={INDEX_ROW} onClick={() => onOpenPreview(s)}>
                    <AppWindowIcon />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                      {s.port ? `:${s.port}` : port(s.url)}
                    </span>
                  </button>
                </li>
              ))}
              {shownArtifacts.map((a) => {
                const index = images.findIndex((i) => i.id === a.id)
                const meta = <span className="shrink-0 text-xs text-muted-foreground">{a.type}</span>
                return (
                  <li key={a.id}>
                    {index >= 0 ? (
                      <ImageTrigger index={index} className={`${INDEX_ROW} cursor-zoom-in`} aria-label={`Open ${a.name}`}>
                        {({ imageRef, morphRef }) => (
                          <>
                            <img
                              ref={(node) => {
                                imageRef(node)
                                morphRef(node)
                              }}
                              src={a.src}
                              alt=""
                              className="size-3.5 shrink-0 rounded-[2px] object-cover outline-1 -outline-offset-1 outline-foreground/15"
                            />
                            <span className="min-w-0 flex-1 truncate">{a.name}</span>
                            {meta}
                          </>
                        )}
                      </ImageTrigger>
                    ) : a.href ? (
                      <a className={INDEX_ROW} href={a.href} target="_blank" rel="noreferrer">
                        <FileIcon />
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        {meta}
                      </a>
                    ) : null}
                  </li>
                )
              })}
            </IndexSection>
          </ImageLightbox>
        )}
      </div>
    </div>
  )
}

/** A pull request on one row: its state icon, title, number (with the repo when the session's PRs span several) and diff stats.
 * A stacked PR is indented under the PR whose branch it builds on (not while searching, when its parent may be filtered out). */
function PrRow({ pr: p, showRepo, indent, onOpen }: { pr: IndexPr; showRepo: boolean; indent: boolean; onOpen: () => void }) {
  const ref = p.number ? `${showRepo && p.repo ? p.repo : ''}#${p.number}` : p.repo
  const depth = indent ? Math.min(p.depth, 4) : 0
  return (
    <button type="button" className={INDEX_ROW} style={depth ? { paddingLeft: `${8 + depth * 18}px` } : undefined} onClick={onOpen}>
      <PrIcon state={p.state} draft={p.draft} />
      <span className="min-w-0 flex-1 truncate">{p.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        {ref}
        {p.additions !== undefined && <Stat additions={p.additions} deletions={p.deletions ?? 0} />}
      </span>
    </button>
  )
}

/**
 * A small window on the agent's computer, between the search box and the lists: its screen at a quarter scale when it is awake
 * and the Computer tab is not open (stream links are single-use, so only one view streams at a time), else the frame with its
 * state. It takes no pointer; a click opens the Computer tab in the New tab's place.
 */
function ComputerWindow({ source, live, onOpen }: { source: ComputerSource; live: boolean; onOpen: () => void }) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [url, setUrl] = useState<string>()
  const { awake, fetchUrl } = source
  useEffect(() => {
    setUrl(undefined)
    if (!live || !awake) return
    let on = true
    fetchUrl({ theme }).then(
      (u) => on && setUrl(u),
      () => {},
    )
    return () => {
      on = false
    }
  }, [live, awake, fetchUrl, theme])
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/win flex w-full flex-col gap-1 rounded-[8px] text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="relative block aspect-[16/10] w-full overflow-hidden rounded-[8px] bg-app outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {url ? (
          <iframe
            src={url}
            title="Agent's computer, preview"
            tabIndex={-1}
            aria-hidden
            referrerPolicy="no-referrer"
            allow="autoplay"
            className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <MonitorIcon className="size-6" strokeWidth={1.5} />
          </span>
        )}
      </span>
      <span className={`${INDEX_ROW} group-hover/win:bg-foreground/[0.04]`}>
        <MonitorIcon />
        <span className="flex-1">Computer</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {awake && <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />}
          {awake ? 'Awake' : 'Asleep'}
        </span>
      </span>
    </button>
  )
}

function IndexSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="px-2 text-sm font-normal text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}
