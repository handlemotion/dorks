import type { NoticeHook } from '@dorks/shared'
import {
  MessageSquareIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  EyeIcon,
  EyeOffIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  MessageSquareDiffIcon,
  RocketIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'

// Autonomy events (docs/autonomy.md) as the thread and Progress show them: one plain line saying what happened ("Got a comment from
// octocat on #12"), with an icon for its kind. The agent receives the full digest; people read this.

export type HookLine = { title: string; icon: LucideIcon }

type Item = { kind: string; summary: string }
type Section = { number: string; items: Item[] }

/** The digest's sections (`## owner/name#12: title`) and their items (`- kind: summary`), as `renderNotification` writes them. */
function sections(text: string): Section[] {
  const out: Section[] = []
  for (const line of text.split('\n')) {
    const head = /^## [^#\s]+#(\d+)/.exec(line)
    if (head) out.push({ number: head[1], items: [] })
    const item = /^- ([a-z_]+)(?: \([^)]*\))?: (.*)$/.exec(line)
    if (item && out.length) out[out.length - 1].items.push({ kind: item[1], summary: item[2] })
  }
  return out
}

const names = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const loginOf = (summary: string) => summary.split(' ')[0]
const unique = (xs: string[]) => [...new Set(xs)]

/** What happened on one PR, most telling first. */
function phrases({ number, items }: Section): string[] {
  const pr = `#${number}`
  const of = (kind: string) => items.filter((i) => i.kind === kind)
  const out: string[] = []
  if (of('closed').length) out.push(`${pr} was ${of('closed')[0].summary.startsWith('Merged') ? 'merged' : 'closed'}`)
  if (of('ci_failed').length) out.push(`CI failed on ${pr}`)
  if (of('conflict').length) out.push(`${pr} has merge conflicts`)
  if (of('base_changed').length) out.push(`${pr}'s base branch changed`)
  for (const r of of('review')) {
    const login = loginOf(r.summary)
    const verb = r.summary.slice(login.length + 1)
    out.push(verb.startsWith('approved') ? `${login} approved ${pr}` : verb.startsWith('requested changes') ? `${login} requested changes on ${pr}` : `Got a review from ${login} on ${pr}`)
  }
  const comments = of('comment')
  if (comments.length) out.push(`Got ${comments.length === 1 ? 'a comment' : `${comments.length} comments`} from ${names(unique(comments.map((c) => loginOf(c.summary))))} on ${pr}`)
  if (of('ship_failed').length) out.push(`${pr} failed to ship`)
  if (of('deployed').length) out.push(`${pr} is live; checking it there`)
  if (of('ready').length) out.push(`${pr} is green and approved`)
  else if (of('ci_passed').length) out.push(`CI passed on ${pr}`)
  return out
}

/** The icon of the most telling kind in a digest. */
const NOTIFY_ICONS: [string, LucideIcon][] = [
  ['ship_failed', CircleXIcon],
  ['ci_failed', CircleXIcon],
  ['conflict', TriangleAlertIcon],
  ['closed', GitMergeIcon],
  ['review', MessageSquareDiffIcon],
  ['comment', MessageCircleIcon],
  ['base_changed', GitBranchIcon],
  ['deployed', RocketIcon],
  ['ready', CircleCheckIcon],
  ['ci_passed', CircleCheckIcon],
]

function notifyLine(hook: Extract<NoticeHook, { type: 'notify' }>): HookLine {
  if (hook.source === 'preview') {
    // The owner's own comments on the preview: the digest is their words, one comment per paragraph.
    const comments = hook.text.split('\n\n').filter((t) => t.trim())
    const first = comments[0]?.split('\n')[0] ?? ''
    const title = comments.length > 1 ? `${comments.length} comments on the preview` : `Comment on the preview: “${first.length > 80 ? `${first.slice(0, 80)}…` : first}”`
    return { title, icon: MessageSquareIcon }
  }
  const said = sections(hook.text).flatMap(phrases)
  const prs = hook.prs.map((p) => `#${p.number}`)
  const title = said.length ? said.join('; ') : `Update on ${names(prs) || 'your pull request'}`
  const icon = NOTIFY_ICONS.find(([kind]) => hook.kinds.includes(kind as never))?.[1] ?? GitPullRequestIcon
  return { title, icon }
}

function subscriptionLine(hook: Extract<NoticeHook, { type: 'subscription' }>): HookLine {
  const pr = `#${hook.number}`
  if (hook.status === 'stalled') return { title: `Stopped fixing CI on ${pr}${hook.reason ? `: ${hook.reason}` : ''}`, icon: CircleAlertIcon }
  if (hook.status === 'ended') return { title: `Stopped watching ${pr}${hook.reason ? ` (${hook.reason})` : ''}`, icon: EyeOffIcon }
  if (hook.reason === 'CI passed') return { title: `CI passed on ${pr}; fixing again if it fails`, icon: CircleCheckIcon }
  return { title: `${hook.reason === 'resumed' ? 'Watching again' : 'Watching'} ${pr} for CI, reviews and comments`, icon: EyeIcon }
}

export function hookLine(hook: NoticeHook): HookLine {
  switch (hook.type) {
    case 'notify':
      return notifyLine(hook)
    case 'pr_opened':
      return { title: `Opened PR #${hook.number}`, icon: GitPullRequestIcon }
    case 'pr_merged':
      return { title: `PR #${hook.number} merged`, icon: GitMergeIcon }
    case 'subscription':
      return subscriptionLine(hook)
  }
}
