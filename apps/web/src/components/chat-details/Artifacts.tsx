import type { ReactNode } from 'react'
import { Button } from '@dorks/ui/button'
import { EmptyState } from '../EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from '../ImageLightbox'
import { port, type PreviewServer } from '../PreviewBrowser'
import { Stat, sum, type FileChange } from '../PullRequestPanel'
import type { Artifact } from './types'

/**
 * A grid of tiles split by full hairlines (each tile draws its right and bottom edge; the grid hides only the outer right one, so the last row keeps its bottom line). The first tile
 * is the code changes, when there are any.
 */
export function Artifacts({
  artifacts,
  changes,
  previews,
  onOpenChanges,
  onOpenPreview,
  onAsk,
}: {
  artifacts: Artifact[]
  changes: FileChange[]
  previews: PreviewServer[]
  onOpenChanges: () => void
  onOpenPreview: (server: PreviewServer) => void
  onAsk?: (text: string) => void
}) {
  if (artifacts.length === 0 && changes.length === 0 && previews.length === 0)
    return (
      <EmptyState figure="drawer" title="No artifacts yet" description="Screenshots, running previews and files from this chat show up here.">
        {onAsk && (
          <Button size="sm" variant="outline" onClick={() => onAsk('Take a screenshot of the current UI and add it to the artifacts.')}>
            Ask for a screenshot
          </Button>
        )}
      </EmptyState>
    )
  // The images among the artifacts share one lightbox, so opening one pages through the others.
  const images: LightboxImage[] = artifacts.filter((a) => a.src).map((a) => ({ id: a.id, src: a.src!, alt: a.name, caption: a.name, width: a.width, height: a.height }))
  return (
    <ImageLightbox images={images} label="Artifacts">
      <div className="@container overflow-hidden border-t">
        <ul className="-mr-px grid grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-4">
          {changes.length > 0 && (
            <Tile onClick={onOpenChanges} thumb={() => <DiffThumb />} label={<Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} />} meta={`${changes.length} files`}>
              Code changes
            </Tile>
          )}
          {previews.map((server) => (
            <Tile
              key={server.url}
              onClick={() => onOpenPreview(server)}
              thumb={() => <PreviewThumb server={server} />}
              label={
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                  Running
                </span>
              }
              meta={server.port ? `:${server.port}` : port(server.url)}
            >
              {server.name}
            </Tile>
          ))}
          {artifacts.map((a) => {
            const index = images.findIndex((i) => i.id === a.id)
            return (
              <Tile
                key={a.id}
                image={index >= 0 ? index : undefined}
                href={a.href}
                thumb={(imageRef) => (a.src ? <img ref={imageRef} src={a.src} alt="" className="size-full object-cover" /> : null)}
                label={a.type}
              >
                {a.name}
              </Tile>
            )
          })}
        </ul>
      </div>
    </ImageLightbox>
  )
}

type ImageRef = (node: HTMLImageElement | null) => void

/** A tile: an image opens the artifacts lightbox at `image`, anything else opens `href` or runs `onClick`. */
function Tile({
  thumb,
  label,
  meta,
  image,
  href,
  onClick,
  children,
}: {
  thumb: (imageRef?: ImageRef) => ReactNode
  label: ReactNode
  meta?: string
  image?: number
  href?: string
  onClick?: () => void
  children: string
}) {
  const body = (imageRef?: ImageRef) => (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-[8px] bg-app outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">{thumb(imageRef)}</div>
      <div className="mt-3.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        {label}
        {meta && <span className="tabular-nums">{meta}</span>}
      </div>
      <div className="mt-1 truncate text-sm" title={children}>
        {children}
      </div>
    </>
  )
  const cls = 'block w-full px-(--details-text) pt-5 pb-4 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
  return (
    <li className="border-r border-b">
      {image !== undefined ? (
        <ImageTrigger index={image} className={`${cls} cursor-zoom-in`} aria-label={`Open ${children}`}>
          {/* Only the image morphs into the viewer (morphRef), not the whole tile with its labels. */}
          {({ imageRef, morphRef }) =>
            body((node) => {
              imageRef(node)
              morphRef(node)
            })
          }
        </ImageTrigger>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick}>
          {body()}
        </button>
      ) : href ? (
        <a className={cls} href={href} target="_blank" rel="noreferrer">
          {body()}
        </a>
      ) : (
        <div className={cls}>{body()}</div>
      )}
    </li>
  )
}

/**
 * A running preview's thumbnail: the live page itself, laid out at four times the tile's width and scaled down to fit, so it reads
 * like a screenshot of a desktop window. It takes no pointer or focus; the tile opens the real one.
 */
function PreviewThumb({ server }: { server: PreviewServer }) {
  return (
    <div className="relative size-full bg-white">
      <iframe
        src={server.html ? undefined : server.url}
        srcDoc={server.html}
        title={`${server.name} preview`}
        tabIndex={-1}
        aria-hidden
        loading="lazy"
        className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25"
      />
    </div>
  )
}

/** A few diff lines, drawn: the code-changes tile's thumbnail. */
function DiffThumb() {
  const rows = ['w-1/2 bg-foreground/10', 'w-3/4 bg-red-500/70', 'w-2/3 bg-emerald-500/70', 'w-4/5 bg-emerald-500/70', 'w-1/2 bg-emerald-500/70', 'w-3/5 bg-foreground/10']
  return (
    <div className="flex size-full flex-col justify-center gap-1.5 px-[18%]">
      {rows.map((r, i) => (
        <div key={i} className={`h-1.5 rounded-full ${r}`} />
      ))}
    </div>
  )
}
