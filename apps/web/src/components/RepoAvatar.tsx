import { useState } from 'react'
import { cn } from './onboarding/Frame'

/** A GitHub owner's avatar (user or organization), or its initial on a faint fill when it can't load. */
export function OwnerAvatar({ owner, size = 16, className }: { owner: string; size?: 16 | 18 | 20; className?: string }) {
  const [failed, setFailed] = useState(false)
  const box = cn('shrink-0 overflow-hidden rounded-[4px]', className)
  if (failed || !owner) {
    return (
      <span aria-hidden style={{ width: size, height: size }} className={cn(box, 'grid place-items-center bg-foreground/10 text-[10px] leading-none text-muted-foreground uppercase')}>
        {owner.slice(0, 1) || '?'}
      </span>
    )
  }
  return <img alt="" src={`https://github.com/${encodeURIComponent(owner)}.png?size=${size * 2}`} width={size} height={size} className={box} onError={() => setFailed(true)} />
}

/** The owner of an `owner/name` repository. */
export const ownerOf = (repo: string) => repo.split('/')[0] ?? ''
