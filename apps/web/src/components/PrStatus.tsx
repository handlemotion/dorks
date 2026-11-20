import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, type LucideIcon } from 'lucide-react'

/** A pull request's state: `open` covers drafts (see `draft`); `merged` and `closed` are final. */
export type PrStatusState = 'open' | 'merged' | 'closed'

/** `className` colours text; `iconClassName` is the same colour marked important, so it wins over a container's muted icon colour. */
export type PrStatus = { Icon: LucideIcon; label: 'Open' | 'Draft' | 'Merged' | 'Closed'; className: string; iconClassName: string }

const MERGED: PrStatus = { Icon: GitMergeIcon, label: 'Merged', className: 'text-violet-600 dark:text-violet-400', iconClassName: 'text-violet-600! dark:text-violet-400!' }
const CLOSED: PrStatus = { Icon: GitPullRequestClosedIcon, label: 'Closed', className: 'text-red-600 dark:text-red-400', iconClassName: 'text-red-600! dark:text-red-400!' }
const DRAFT: PrStatus = { Icon: GitPullRequestDraftIcon, label: 'Draft', className: 'text-muted-foreground', iconClassName: 'text-muted-foreground!' }
const UNKNOWN: PrStatus = { Icon: GitPullRequestIcon, label: 'Open', className: 'text-muted-foreground', iconClassName: 'text-muted-foreground!' }
const OPEN: PrStatus = { Icon: GitPullRequestIcon, label: 'Open', className: 'text-emerald-600 dark:text-emerald-400', iconClassName: 'text-emerald-600! dark:text-emerald-400!' }

/**
 * Everywhere a pull request shows (the PR panel's header, its tab, the New tab index, the sidebar's `#N`), its state picks the icon
 * and the colour, as on GitHub: open green, merged violet, closed red, draft grey. A state not known yet is grey, never a guessed green.
 */
export function prStatus(state: PrStatusState | undefined, draft?: boolean): PrStatus {
  if (state === 'merged') return MERGED
  if (state === 'closed') return CLOSED
  if (state === 'open') return draft ? DRAFT : OPEN
  return UNKNOWN
}

/** The state's icon in its colour. */
export function PrIcon({ state, draft, className = '' }: { state: PrStatusState | undefined; draft?: boolean; className?: string }) {
  const { Icon, label, iconClassName } = prStatus(state, draft)
  return <Icon aria-label={label} className={`${iconClassName} ${className}`} />
}
