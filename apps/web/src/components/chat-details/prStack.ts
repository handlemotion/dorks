import type { PrStackEntry } from '../PullRequestPanel'
import { sum } from '../PullRequestPanel'
import type { PrStatusState } from '../PrStatus'
import type { ChatDetailsData } from './types'

/**
 * One of the session's pull requests. `depth`: how far down a stack it sits (0: on a branch no other PR of the session has; 1: on
 * another PR's branch, as GitHub stacked PRs are; and so on). `foreign`: in another repository than the session's PRs mostly are.
 */
export type IndexPr = {
  url: string
  title: string
  repo?: string
  number?: number
  additions?: number
  deletions?: number
  state?: PrStatusState
  draft?: boolean
  headRef?: string
  baseRef?: string
  depth: number
  parent?: string
}

/**
 * The session's pull requests: its subscriptions (merged and closed ones too) and its headline PR, the headline's live read
 * filling in what the subscription lacks. Ordered as stacks read: a PR, then the PRs built on its branch (by number), then the
 * next root.
 */
export function sessionPrs(data: ChatDetailsData): IndexPr[] {
  const byUrl = new Map<string, Omit<IndexPr, 'depth'>>()
  for (const s of data.subscriptions ?? []) {
    byUrl.set(s.url, { url: s.url, title: s.title ?? `Pull request #${s.number}`, repo: s.repo, number: s.number, state: s.state, headRef: s.headRef, baseRef: s.baseRef })
  }
  if (data.pr) byUrl.set(data.pr.url, headlinePr(data, data.pr, byUrl.get(data.pr.url)))
  return stackOrder([...byUrl.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)))
}

/** The headline PR: its live read when there is one, else what its subscription and the stored link know. */
function headlinePr(data: ChatDetailsData, pr: NonNullable<ChatDetailsData['pr']>, known: Omit<IndexPr, 'depth'> | undefined): Omit<IndexPr, 'depth'> {
  const view = data.pullRequest?.view
  if (view && view.url === pr.url) {
    const { title, repo, number, state, draft, headRef, baseRef, additions, deletions } = view
    return { url: pr.url, title, repo, number, state, draft, headRef, baseRef, additions, deletions }
  }
  const changes = data.changes ?? []
  return {
    ...known,
    url: pr.url,
    title: known?.title ?? 'Pull request',
    repo: known?.repo ?? repoOf(pr.url),
    number: known?.number ?? pr.number,
    state: pr.state ?? known?.state,
    additions: sum(changes, 'additions'),
    deletions: sum(changes, 'deletions'),
  }
}

/** Each PR, then the PRs built on its branch (another PR of the same repo whose head is its base), depth first. */
export function stackOrder(all: Omit<IndexPr, 'depth'>[]): IndexPr[] {
  const parentOf = (p: Omit<IndexPr, 'depth'>) => (p.baseRef ? all.find((o) => o !== p && o.repo === p.repo && o.headRef === p.baseRef) : undefined)
  const out: IndexPr[] = []
  const placed = new Set<string>()
  const place = (p: Omit<IndexPr, 'depth'>, depth: number, parent?: string) => {
    if (placed.has(p.url)) return
    placed.add(p.url)
    out.push({ ...p, depth, parent })
    for (const child of all) if (parentOf(child) === p) place(child, depth + 1, p.url)
  }
  for (const p of all) if (!parentOf(p)) place(p, 0)
  for (const p of all) place(p, 0) // a cycle of branches: list what is left flat
  return out
}

/** The stack a PR belongs to, root first (the PR's whole tree, in list order); undefined when it stands alone. */
export function stackOf(prs: IndexPr[], url: string): PrStackEntry[] | undefined {
  const at = prs.findIndex((p) => p.url === url)
  if (at < 0) return undefined
  let root = at
  while (prs[root].depth > 0) root--
  let end = root + 1
  while (end < prs.length && prs[end].depth > 0) end++
  if (end - root < 2) return undefined
  return prs.slice(root, end).map((p) => ({ url: p.url, number: p.number, title: p.title, state: p.state, draft: p.draft, parent: p.parent, current: p.url === url }))
}

/** The url of the root of the stack a PR is in, which names the stack's one tab; undefined when the PR stands alone. */
export function stackRoot(prs: IndexPr[], url: string): string | undefined {
  return stackOf(prs, url)?.[0].url
}

/** "owner/name" from a GitHub pull request url. */
function repoOf(url: string) {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]
}
