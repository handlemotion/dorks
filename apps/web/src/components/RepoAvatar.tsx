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

/** The distinct owners of some `owner/name` repositories, in order. */
export const repoOwners = (repos: string[]) => [...new Set(repos.map(ownerOf).filter(Boolean))]

/**
 * Several owners' avatars overlapped (a build's repositories): the app's 4px-rounded 16px squares, each cut out of the one under it by a
 * ring of the surface it sits on (`ring`), at most three and then a +N.
 */
export function OwnerStack({ owners, ring = 'ring-background', max = 3 }: { owners: string[]; ring?: string; max?: number }) {
  const shown = owners.length > max ? owners.slice(0, max - 1) : owners
  const more = owners.length - shown.length
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1" data-testid="owner-stack">
      {shown.map((o) => (
        <span key={o} className={cn('rounded-[5px] ring-[1.5px]', ring)}>
          <OwnerAvatar owner={o} className="block" />
        </span>
      ))}
      {more > 0 && (
        <span className={cn('grid h-4 min-w-4 place-items-center rounded-[5px] bg-muted px-0.5 text-[10px] leading-none text-muted-foreground tabular-nums ring-[1.5px]', ring)}>+{more}</span>
      )}
    </span>
  )
}

/** The owner of an `owner/name` repository. */
export const ownerOf = (repo: string) => repo.split('/')[0] ?? ''

export const REPO = /^[\w.-]+\/[\w.-]+$/

/** One repository row: the owner's avatar, then `owner/name` with the owner muted. */
export function RepoRow({ repo }: { repo: string }) {
  const owner = ownerOf(repo)
  return (
    <>
      <OwnerAvatar owner={owner} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{owner}/</span>
        {repo.slice(owner.length + 1)}
      </span>
    </>
  )
}

export const REPO_ITEM = 'h-8 gap-2 rounded-[6px] px-2 py-0 font-normal data-selected:bg-foreground/[0.05] [&>svg:last-child]:size-3.5'
