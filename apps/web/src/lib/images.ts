/** A shared image's URL (`…/images/<id>`), as the server's smaller copy at `width` px; any other URL as it is. */
export function sizedImage(src: string, width: number): string {
  return /\/images\/[0-9a-f]{32}$/.test(src) ? `${src}?w=${width}` : src
}

/** Tiles, the viewer's thumbnail strip, small previews: 2x a ~300 px tile. */
export const THUMB_WIDTH = 640
/** A screenshot in the thread (up to 360 px tall, wide desktop shots stay crisp at 2x). */
export const INLINE_WIDTH = 1920
