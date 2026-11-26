// Profile pictures and org logos (Settings › Account and Organization): Dorks Cloud takes a PNG, JPEG or WebP of at most 2 MB and
// crops it to a 512 px square itself. A file it would refuse (a large photo, a GIF, a HEIC the browser can decode) is cropped and
// re-encoded here first, so picking any picture works.

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 2 * 1024 * 1024
const SIZE = 512

/** What the file picker offers. */
export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/heic,image/avif'

/** The file as it is when the cloud takes it, else a centred square WebP of it. */
export async function preparePicture(file: File): Promise<Blob> {
  if (ACCEPTED.includes(file.type) && file.size <= MAX_BYTES) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That file is not a picture this app can read. Choose a PNG, JPEG or WebP.')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = Math.min(SIZE, side)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare the picture')
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
  if (!blob) throw new Error('Could not prepare the picture')
  return blob
}
