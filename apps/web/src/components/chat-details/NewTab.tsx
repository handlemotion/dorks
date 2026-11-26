import { useState, type ReactNode } from 'react'
import { AppWindowIcon, FileIcon, SearchIcon } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@dorks/ui/input-group'
import { EmptyState } from '../EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from '../ImageLightbox'
import { port, type PreviewServer } from '../PreviewBrowser'
import { Stat } from '../PullRequestPanel'
import { PrIcon } from '../PrStatus'
import type { IndexPr } from './prStack'
import type { Artifact } from './types'

/** A 30px row in the New tab: an icon and a label, the hover fill of the bar's buttons. */
const INDEX_ROW =
  'flex h-[30px] w-full items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

/**
 * A New tab: an index of what the session holds. A search box filters the pull requests, artifacts and panels below by name; each
 * opens in this tab's place. Sections with nothing in them are left out.
 */
export function NewTab<P extends string>({
  prs,
  artifacts,
  previews,
  panels,
  panelLabel,
  panelIcon,
  onOpen,
  onOpenPreview,
}: {
  prs: IndexPr[]
  artifacts: Artifact[]
  previews: PreviewServer[]
  /** The panels to list under Tools (without those another section already lists, such as the local diff once PRs have rows). */ panels: P[]
  panelLabel: (p: P) => string
  panelIcon: (p: P) => ReactNode
  onOpen: (target: P | `pr:${string}`) => void
  onOpenPreview: (server: PreviewServer) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const match = (...names: (string | undefined)[]) => !q || names.some((n) => n?.toLowerCase().includes(q))
  const manyRepos = new Set(prs.map((p) => p.repo)).size > 1
  const shownPrs = prs.filter((p) => match(p.title, p.repo, p.number ? `#${p.number}` : undefined))
  const shownPreviews = previews.filter((s) => match(s.name))
  const shownArtifacts = artifacts.filter((a) => (a.src || a.href) && match(a.name, a.type))
  const shownPanels = panels.filter((p) => match(panelLabel(p)))
  const images: LightboxImage[] = artifacts
    .filter((a) => a.src)
    .map((a) => ({ id: a.id, src: a.src!, thumb: a.thumb, alt: a.name, caption: a.name, width: a.width, height: a.height, imageId: a.imageId }))
  const totalRows = prs.length + previews.length + artifacts.filter((a) => a.src || a.href).length + panels.length
  const nothing = shownPrs.length + shownPreviews.length + shownArtifacts.length + shownPanels.length === 0
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto flex w-full max-w-[420px] flex-col gap-6 px-5 pb-10 ${totalRows > 6 ? 'pt-14' : 'pt-[18vh]'}`}>
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
                              src={a.thumb ?? a.src}
                              alt=""
                              loading="lazy"
                              decoding="async"
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

function IndexSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="px-2 text-sm font-normal text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}
