import { useRef, useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { Button } from '@dorks/ui/button'
import { PICTURE_ACCEPT, preparePicture } from '../../lib/picture'
import { usePending } from '../../lib/pending'

/**
 * A picture with Upload and Remove: the account's (round) or an org's logo (a 6px-rounded square, like the switcher's 4px marks). The
 * file is prepared in the browser (lib/picture.ts) and sent to Dorks Cloud through this computer's server.
 */
export function PictureRow({
  label,
  image,
  shape,
  fallback,
  onUpload,
  onRemove,
}: {
  label: string
  image: string | null
  shape: 'round' | 'square'
  /** What shows without a picture: initials, a glyph. */
  fallback: ReactNode
  onUpload: (picture: Blob) => Promise<unknown>
  onRemove: () => Promise<unknown>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const { run, pending, error } = usePending()
  const box = cn('size-10 shrink-0 overflow-hidden bg-foreground/10', shape === 'round' ? 'rounded-full' : 'rounded-[6px]')
  const shown = image && broken !== image
  return (
    <div data-slot="settings-row" className="flex min-h-16 w-full min-w-0 flex-wrap items-center gap-3 py-3 ps-4 pe-3">
      {shown ? (
        <img alt="" src={image} width={40} height={40} className={cn(box, 'object-cover')} onError={() => setBroken(image)} />
      ) : (
        <span aria-hidden className={cn(box, 'grid place-items-center text-sm text-muted-foreground')}>
          {fallback}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm leading-4 text-foreground">{label}</span>
        {error ? (
          <span role="alert" className="text-xs leading-4 text-destructive">
            {error}
          </span>
        ) : (
          <span className="text-xs leading-4 text-pretty text-muted-foreground">{pending ? 'Uploading…' : 'PNG, JPEG or WebP, up to 2 MB. Cropped to a square.'}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={PICTURE_ACCEPT}
          className="hidden"
          aria-label={`Choose ${label.toLowerCase()}`}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void run(async () => onUpload(await preparePicture(file)))
          }}
        />
        {image && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(onRemove)}>
            Remove
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
          {image ? 'Change…' : 'Upload…'}
        </Button>
      </div>
    </div>
  )
}
