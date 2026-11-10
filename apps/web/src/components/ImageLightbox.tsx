import { createContext, useContext, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import * as Lightbox from '@ramka/react/lightbox'

/** One image a lightbox can show. Give the real pixel size when it is known: the viewer fits and morphs from it. */
export type LightboxImage = { id: string; src: string; alt: string; caption?: string; width?: number; height?: number }

const control =
  'inline-flex size-8 items-center justify-center rounded-(--control-radius) text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4'

/**
 * Every image in the app opens in this lightbox (ramka's headless primitives, `@ramka/react/lightbox`), skinned flat: the app's own
 * background, no shadows, 6px controls. One lightbox per place images live, so navigation stays within that place: the artifacts of a
 * chat page through the artifacts, the images in a transcript through the transcript. Thumbnails open it through `ImageTrigger` with
 * their index in `images`; the viewer morphs from the thumbnail (a View Transition, a fade where unsupported or with reduced motion),
 * swipes, arrow keys or the thumbnail strip move between images, zooms with pinch, wheel or double click, and closes on Escape or by pulling down.
 */
export function ImageLightbox({ images, label, children }: { images: LightboxImage[]; label: string; children: ReactNode }) {
  return (
    <Lightbox.Root count={images.length}>
      <IndexContext.Provider value={images}>{children}</IndexContext.Provider>
      <Lightbox.Portal>
        <Lightbox.Backdrop className="fixed inset-0 bg-background opacity-0 transition-opacity duration-(--lightbox-vt-duration,300ms) data-open:opacity-[calc(1_-_var(--lightbox-pull-progress,0)*0.6)] data-open:starting:opacity-0 data-pulling:transition-none" />
        <Lightbox.Content aria-label={label} className="group/lb fixed inset-0 flex flex-col outline-none">
          <Lightbox.Slides aria-roledescription="carousel" aria-label={label} className="flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {images.map((image, index) => (
              <Lightbox.Slide key={image.id} className={`h-full min-w-full flex-[0_0_100%] px-16 pt-14 ${images.length > 1 ? 'pb-[134px]' : 'pb-16'}`}>
                <Lightbox.Item index={index} caption={image.caption ?? image.alt} aria-roledescription="slide" aria-label={`${index + 1} of ${images.length}`} className="size-full">
                  <Lightbox.Zoom>
                    <Lightbox.Media width={image.width} height={image.height} className="overflow-hidden rounded-(--control-radius)">
                      <img src={image.src} alt={image.alt} className="size-full object-contain select-none" draggable={false} />
                    </Lightbox.Media>
                  </Lightbox.Zoom>
                </Lightbox.Item>
              </Lightbox.Slide>
            ))}
          </Lightbox.Slides>
          <div className="pointer-events-none fixed inset-x-0 top-0 flex h-14 items-center justify-between px-4 group-data-pulling/lb:opacity-0">
            <Lightbox.Counter className="text-sm text-muted-foreground tabular-nums">{({ current, total }) => (total > 1 ? `${current} / ${total}` : null)}</Lightbox.Counter>
            <Lightbox.Close aria-label="Close" className={`pointer-events-auto ${control}`}>
              <XIcon />
            </Lightbox.Close>
          </div>
          {images.length > 1 && (
            <>
              <Lightbox.Previous aria-label="Previous image" className={`fixed top-1/2 left-4 -translate-y-1/2 group-data-pulling/lb:opacity-0 ${control}`}>
                <ChevronLeftIcon />
              </Lightbox.Previous>
              <Lightbox.Next aria-label="Next image" className={`fixed top-1/2 right-4 -translate-y-1/2 group-data-pulling/lb:opacity-0 ${control}`}>
                <ChevronRightIcon />
              </Lightbox.Next>
            </>
          )}
          {/* Bottom band: the caption, then (with more than one image) a strip of thumbnails that scrolls under a fixed ring on the
              active one (brand blue), like Photos. The caption sits evenly between the image and the ring on the
              active thumbnail, about 15px each side (the slide's bottom padding is this band's height plus that gap). */}
          <div className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center gap-3 pb-5 group-data-pulling/lb:opacity-0">
            <Lightbox.Caption className="flex min-h-5 items-center px-16 text-center text-sm text-muted-foreground" />
            {images.length > 1 && (
              <Lightbox.ThumbnailStrip className="pointer-events-auto relative w-full min-w-0 self-stretch py-[5px] [--thumb:3.5rem] [mask-image:linear-gradient(to_right,transparent,#000_48px,#000_calc(100%-48px),transparent)]">
                <Lightbox.ThumbnailStripTrack aria-label={`${label} thumbnails`} className="flex w-max items-center gap-2">
                  {images.map((image, index) => (
                    <Lightbox.Thumbnail key={image.id} index={index} aria-label={image.alt} className="relative block size-(--thumb) shrink-0 cursor-pointer overflow-hidden rounded-(--control-radius) bg-app outline-none focus-visible:outline-2 focus-visible:outline-ring">
                      <img src={image.src} alt="" draggable={false} className="block size-full object-cover" />
                    </Lightbox.Thumbnail>
                  ))}
                </Lightbox.ThumbnailStripTrack>
                <span aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 size-[calc(var(--thumb)+8px)] -translate-x-1/2 -translate-y-1/2 rounded-[10px] border-2 border-brand" />
              </Lightbox.ThumbnailStrip>
            )}
          </div>
        </Lightbox.Content>
      </Lightbox.Portal>
    </Lightbox.Root>
  )
}

const IndexContext = createContext<LightboxImage[]>([])

/** The images of the nearest `ImageLightbox`, so a thumbnail can find its own index by source. */
export function useLightboxImages() {
  return useContext(IndexContext)
}

/** A thumbnail that opens the nearest `ImageLightbox` at `index`. Put `imageRef` on its `<img>` so the viewer morphs from it. */
export const ImageTrigger = Lightbox.Trigger
