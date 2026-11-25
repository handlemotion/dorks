import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, MessageSquarePlusIcon, MessagesSquareIcon, XIcon } from 'lucide-react'
import * as Lightbox from '@ramka/react/lightbox'
import type { CommentThread } from '@dorks/shared'
import { PreviewMarks } from './preview/PreviewMarks'
import type { Rect } from './preview/useOverlay'
import { Rail, RailDivider, ToolButton } from './PreviewBrowser'
import { Tip } from './Tip'
import { useImageComments, type ImageAnchor } from './ImageComments'

/** One image a lightbox can show. Give the real pixel size when it is known: the viewer fits and morphs from it. */
export type LightboxImage = {
  id: string
  src: string
  alt: string
  caption?: string
  width?: number
  height?: number
  /** A smaller copy for the thumbnail column. */ thumb?: string
  /** The image's `dorks-image` id when the session's server keeps it: such an image can be commented on. */ imageId?: string
}

const control =
  'inline-flex size-8 items-center justify-center rounded-(--control-radius) text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4'
/** The toolbar's Previous and Next: the rail's 28px tools. */
const railControl =
  'inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5'

/** The thumbnail column's width: 56px thumbnails, 24px from the screen's edge and 24px from the image. */
const COLUMN = 104

/**
 * Every image in the app opens in this lightbox (ramka's headless primitives, `@ramka/react/lightbox`), skinned flat: the app's own
 * background at 85% over a blur of what is under it, no shadows, 6px controls, above everything in the app (z-50: the sidebar rows and the floating title bar controls are stacked). One lightbox per place images live, so navigation stays within that place: the artifacts of a
 * chat page through the artifacts, the images in a transcript through the transcript. Thumbnails open it through `ImageTrigger` with
 * their index in `images`; the viewer morphs from the thumbnail (a View Transition, a fade where unsupported or with reduced motion),
 * swipes, arrow keys or the thumbnail column move between images, zooms with pinch, wheel or double click, and closes on Escape or by pulling down.
 *
 * With more than one image, the thumbnails run down a column on the left. Under the image, one toolbar (the preview's rail): Previous,
 * the count and Next, the caption, then, on an image the session's server keeps, Comment (a click on the image leaves a comment on
 * that point, a drag on that area) and Show comments. Comments are the preview's threads (`ImageComments.tsx`).
 */
export function ImageLightbox({ images, label, children }: { images: LightboxImage[]; label: string; children: ReactNode }) {
  const [index, setIndex] = useState(0)
  const media = useRef(new Map<number, HTMLElement>())
  const multiple = images.length > 1
  return (
    <Lightbox.Root count={images.length} onValueChange={(value) => setIndex(value)}>
      <IndexContext.Provider value={images}>{children}</IndexContext.Provider>
      <Lightbox.Portal>
        <Lightbox.Backdrop className="fixed inset-0 z-50 bg-background/85 opacity-0 backdrop-blur-md transition-opacity duration-(--lightbox-vt-duration,300ms) data-open:opacity-[calc(1_-_var(--lightbox-pull-progress,0)*0.6)] data-open:starting:opacity-0 data-pulling:transition-none" />
        <Lightbox.Content aria-label={label} className="group/lb fixed inset-0 z-50 flex flex-col outline-none">
          <Lightbox.Slides preload={2} aria-roledescription="carousel" aria-label={label} className="flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {images.map((image, i) => (
              <Lightbox.Slide key={image.id} className="h-full min-w-full flex-[0_0_100%] pt-14 pr-16 pb-[76px]" style={{ paddingLeft: multiple ? COLUMN : 64 }}>
                <Lightbox.Item index={i} caption={image.caption ?? image.alt} aria-roledescription="slide" aria-label={`${i + 1} of ${images.length}`} className="size-full">
                  <Lightbox.Zoom>
                    <SlideMedia
                      image={image}
                      register={(node) => {
                        if (node) media.current.set(i, node)
                        else media.current.delete(i)
                      }}
                    />
                  </Lightbox.Zoom>
                </Lightbox.Item>
              </Lightbox.Slide>
            ))}
          </Lightbox.Slides>
          <Chrome images={images} index={Math.min(index, images.length - 1)} label={label} media={media.current} />
        </Lightbox.Content>
      </Lightbox.Portal>
    </Lightbox.Root>
  )
}

/** Everything over the slides: Close, the thumbnail column, the toolbar under the image and the comments on it. */
function Chrome({ images, index, label, media }: { images: LightboxImage[]; index: number; label: string; media: Map<number, HTMLElement> }) {
  const image = images[index]
  const multiple = images.length > 1
  const comments = useImageComments(image?.imageId)
  const [commenting, setCommenting] = useState(false)
  const [showComments, setShowComments] = useState(true)
  const [draft, setDraft] = useState<ImageAnchor | null>(null)
  const [active, setActive] = useState<string | null>(null)
  // Another image drops what was being done on this one.
  useEffect(() => {
    setCommenting(false)
    setDraft(null)
    setActive(null)
  }, [index])
  const box = useMediaBox(() => media.get(index) ?? null, !!comments)
  // Escape backs out of commenting first (the tool, then a thread), and only closes the lightbox when nothing is open. A comment box
  // handles its own Escape.
  const engaged = commenting || !!draft || !!active
  useEffect(() => {
    if (!engaged) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target instanceof HTMLElement && e.target.closest('textarea, input'))) return
      e.preventDefault()
      e.stopPropagation()
      if (draft) setDraft(null)
      else if (active) setActive(null)
      else setCommenting(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [engaged, draft, active])

  const toScreen = useCallback(
    (a: Pick<ImageAnchor, 'x' | 'y' | 'width' | 'height'>): Rect | null =>
      box ? { x: box.x + a.x * box.width, y: box.y + a.y * box.height, width: (a.width ?? 0) * box.width, height: (a.height ?? 0) * box.height } : null,
    [box],
  )
  const shown = showComments ? placed(comments?.threads ?? [], toScreen) : []
  const draftBox = draft ? toScreen(draft) : null

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-0 flex h-14 items-center justify-end px-4 group-data-pulling/lb:opacity-0">
        <Lightbox.Close aria-label="Close" className={`pointer-events-auto ${control}`}>
          <XIcon />
        </Lightbox.Close>
      </div>
      {multiple && <ThumbnailColumn images={images} index={index} label={label} />}
      {comments && box && (
        <div className="pointer-events-none fixed inset-0 group-data-pulling/lb:opacity-0">
          <PreviewMarks
            threads={shown}
            names={comments.names}
            actions={{
              ...comments.actions,
              resolve: async (thread, resolved) => {
                await comments.actions.resolve(thread, resolved)
                if (resolved) setActive(null)
              },
              remove: async (comment) => {
                await comments.actions.remove(comment)
                setActive((a) => (a === comment ? null : a))
              },
            }}
            active={active}
            setActive={setActive}
            draft={draft && draftBox ? { anchor: draft, box: draftBox } : null}
            onDraftSend={(body) => comments.add(draft!, body)}
            onDraftClose={() => setDraft(null)}
          >
            {draftBox && draftBox.width > 0 && (
              <span aria-hidden className="absolute rounded-[2px] border-2 border-brand bg-brand/10" style={{ left: draftBox.x, top: draftBox.y, width: draftBox.width, height: draftBox.height }} />
            )}
            {commenting && image?.imageId && (
              <PinLayer
                box={box}
                onPlaced={(at) => {
                  setCommenting(false)
                  setActive(null)
                  setDraft({ kind: 'image', image: image.imageId!, label: (image.caption ?? image.alt).slice(0, 200), ...at })
                }}
              />
            )}
          </PreviewMarks>
        </div>
      )}
      <Toolbar
        multiple={multiple}
        comments={comments ? comments.threads.length : null}
        commenting={commenting}
        onComment={() => {
          setDraft(null)
          setActive(null)
          setCommenting((c) => !c)
        }}
        showComments={showComments}
        onShowComments={() => setShowComments((s) => !s)}
      />
    </>
  )
}

/** The toolbar under the image, centred on it: the count between Previous and Next, the caption, the comment tools (`comments`: how many threads, or null where the image cannot be commented on). */
function Toolbar(props: { multiple: boolean; comments: number | null; commenting: boolean; onComment: () => void; showComments: boolean; onShowComments: () => void }) {
  const { multiple } = props
  return (
    <div className="pointer-events-none fixed right-0 bottom-0 flex h-[76px] items-center justify-center px-4 group-data-pulling/lb:opacity-0" style={{ left: multiple ? COLUMN : 0 }}>
      <div className="pointer-events-auto min-w-0">
        <Rail label="Image tools">
          {multiple && (
            <>
              <Tip label="Previous image" side="top">
                <Lightbox.Previous aria-label="Previous image" className={railControl}>
                  <ChevronLeftIcon />
                </Lightbox.Previous>
              </Tip>
              <Lightbox.Counter className="w-14 text-center text-xs text-muted-foreground tabular-nums">{({ current, total }) => `${current} / ${total}`}</Lightbox.Counter>
              <Tip label="Next image" side="top">
                <Lightbox.Next aria-label="Next image" className={railControl}>
                  <ChevronRightIcon />
                </Lightbox.Next>
              </Tip>
              <RailDivider />
            </>
          )}
          <Lightbox.Caption className="w-60 truncate px-2 text-center text-sm text-foreground" />
          {props.comments !== null && (
            <>
              <RailDivider />
              <ToolButton label="Comment on the image" icon={<MessageSquarePlusIcon />} pressed={props.commenting} onClick={props.onComment} />
              <ToolButton
                label={props.showComments ? 'Hide comments' : 'Show comments'}
                icon={<MessagesSquareIcon />}
                pressed={props.showComments && props.comments > 0}
                onClick={props.onShowComments}
                count={props.comments}
                className="w-11! justify-start"
              />
            </>
          )}
        </Rail>
      </div>
    </div>
  )
}

/** The threads on screen, at their spots on the image (none until it is laid out). */
function placed(threads: CommentThread[], toScreen: (a: ImageAnchor) => Rect | null) {
  return threads.flatMap((thread) => {
    const a = thread.root.anchor
    const r = a?.kind === 'image' ? toScreen(a) : null
    return r ? [{ thread, rects: [r] }] : []
  })
}

/**
 * The thumbnails, down a column on the left, centred while they fit and scrolling when they don't; the active one keeps a brand ring
 * and stays in view.
 */
function ThumbnailColumn({ images, index, label }: { images: LightboxImage[]; index: number; label: string }) {
  const column = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const thumb = column.current?.querySelector<HTMLElement>(`[data-thumb="${index}"]`)
    thumb?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [index])
  return (
    <div
      ref={column}
      className="pointer-events-auto fixed top-14 bottom-[76px] left-0 overflow-y-auto [scrollbar-width:none] group-data-pulling/lb:opacity-0 [&::-webkit-scrollbar]:hidden"
      style={{ width: COLUMN }}
    >
      <Lightbox.ThumbnailGroup aria-label={`${label} thumbnails`} className="flex min-h-full flex-col items-center justify-center gap-2 py-1 ps-2">
        {images.map((image, i) => (
          <Lightbox.Thumbnail
            key={image.id}
            index={i}
            data-thumb={i}
            aria-label={image.alt}
            className="relative block size-14 shrink-0 cursor-pointer rounded-(--control-radius) bg-app outline-none before:pointer-events-none before:absolute before:-inset-1 before:rounded-[10px] before:border-2 before:border-transparent focus-visible:outline-2 focus-visible:outline-ring data-active:before:border-brand"
          >
            <img
              src={image.thumb ?? image.src}
              alt=""
              decoding="async"
              draggable={false}
              className="block size-full rounded-(--control-radius) object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          </Lightbox.Thumbnail>
        ))}
      </Lightbox.ThumbnailGroup>
    </div>
  )
}

/**
 * Where the active image is on screen, followed every frame while the lightbox is open (it zooms, pans and slides), so the comments
 * stay on their spot. Null until the image is laid out.
 */
function useMediaBox(get: () => HTMLElement | null, on: boolean): Rect | null {
  const [box, setBox] = useState<Rect | null>(null)
  const latest = useRef(get)
  latest.current = get
  useLayoutEffect(() => {
    if (!on) return setBox(null)
    let frame = 0
    const tick = () => {
      const el = latest.current()
      const r = el?.getBoundingClientRect()
      const next = r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
      setBox((prev) => (prev === next || (prev && next && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) ? prev : next))
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [on])
  return box
}

/** Over the image while Comment is on: a click places a comment on that point, a drag on the area drawn. Fractions of the image. */
function PinLayer({ box, onPlaced }: { box: Rect; onPlaced: (at: { x: number; y: number; width?: number; height?: number }) => void }) {
  const from = useRef<{ x: number; y: number } | null>(null)
  const [drawn, setDrawn] = useState<Rect | null>(null)
  const point = (e: React.PointerEvent) => ({ x: Math.max(0, Math.min(box.width, e.clientX - box.x)), y: Math.max(0, Math.min(box.height, e.clientY - box.y)) })
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  return (
    <div
      aria-label="Click or drag on the image to comment"
      className="pointer-events-auto absolute cursor-crosshair touch-none"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        from.current = point(e)
        setDrawn(null)
      }}
      onPointerMove={(e) => {
        const a = from.current
        if (!a) return
        const b = point(e)
        setDrawn({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
      }}
      onPointerUp={(e) => {
        const a = from.current
        from.current = null
        if (!a) return
        const b = point(e)
        setDrawn(null)
        const w = Math.abs(a.x - b.x)
        const h = Math.abs(a.y - b.y)
        // A drag of a few pixels is a click.
        if (w < 8 || h < 8) return onPlaced({ x: clamp(b.x / box.width), y: clamp(b.y / box.height) })
        onPlaced({ x: clamp(Math.min(a.x, b.x) / box.width), y: clamp(Math.min(a.y, b.y) / box.height), width: clamp(w / box.width), height: clamp(h / box.height) })
      }}
    >
      {drawn && <span aria-hidden className="absolute rounded-[2px] border-2 border-brand bg-brand/10" style={{ left: drawn.x, top: drawn.y, width: drawn.width, height: drawn.height }} />}
    </div>
  )
}

/**
 * The image of one slide, fitted to it. ramka fits the media box from its pixel size, which it reads only once, before the image has
 * loaded; transcript and attached images come without one, so without this the box falls back to the image's natural size and a
 * large screenshot opens far bigger than the screen. The size measured on load fills in for a missing one.
 */
function SlideMedia({ image, register }: { image: LightboxImage; register: (node: HTMLElement | null) => void }) {
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null)
  const known = image.width && image.height ? { width: image.width, height: image.height } : null
  const size = known ?? measured
  return (
    <Lightbox.Media
      ref={register}
      width={size?.width}
      height={size?.height}
      className="overflow-hidden rounded-(--control-radius) outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
    >
      <img
        src={image.src}
        alt={image.alt}
        className="size-full object-contain select-none"
        draggable={false}
        onLoad={
          known
            ? undefined
            : (e) => {
                const { naturalWidth: width, naturalHeight: height } = e.currentTarget
                if (width > 0 && height > 0) setMeasured((prev) => (prev?.width === width && prev.height === height ? prev : { width, height }))
              }
        }
      />
    </Lightbox.Media>
  )
}

const IndexContext = createContext<LightboxImage[]>([])

/** The images of the nearest `ImageLightbox`, so a thumbnail can find its own index by source. */
export function useLightboxImages() {
  return useContext(IndexContext)
}

/** A thumbnail that opens the nearest `ImageLightbox` at `index`. Put `imageRef` on its `<img>` so the viewer morphs from it. */
export const ImageTrigger = Lightbox.Trigger
