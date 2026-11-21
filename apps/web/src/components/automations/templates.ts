import type { AutomationInput, AutomationTrigger } from '@dorks/client'

/** A starting point for a new automation: its triggers (the repository left for the owner to choose) and its instructions. */
export interface AutomationTemplate {
  id: string
  title: string
  description: string
  input: Omit<AutomationInput, 'triggers'> & { triggers: AutomationTrigger[] }
}

/** The owner's own time zone, for a new schedule. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const schedule = (every: 'day' | 'weekdays' | 'week', time: string, day = 1): AutomationTrigger => ({ kind: 'schedule', every, day, time, timezone: localTimeZone(), repo: '' })
const github = (event: 'pr_opened' | 'pr_pushed' | 'pr_merged' | 'issue_opened' | 'comment'): AutomationTrigger => ({ kind: 'github', event, repo: '', authors: [] })

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'review-prs',
    title: 'Review pull requests',
    description: 'Read every new pull request and leave a review with what changed and what looks risky.',
    input: {
      name: 'Review pull requests',
      triggers: [github('pr_opened')],
      instructions: `Review this pull request. Read the diff of every changed file, then post one review comment on the pull request with:

1. Summary: two or three sentences on what it changes and why.
2. Key changes: the most important modifications and their impact.
3. Risks: breaking changes, security concerns, missing tests, large refactors.
4. Suggestions: concrete, file-specific improvements, if any.

Be specific and technical. Do not push commits to the branch.`,
    },
  },
  {
    id: 'answer-comments',
    title: 'Answer comments',
    description: 'When someone comments on an issue or a pull request, answer the question or make the fix they ask for.',
    input: {
      name: 'Answer comments',
      triggers: [github('comment')],
      instructions: `A new comment was posted on GitHub.

1. Read the comment and the issue or pull request it is on.
2. Decide whether it needs action: a question to answer, a bug to fix, or feedback to apply.
3. If it does, do it: answer with an explanation, or push a fix and verify it with the tests.
4. Reply to the comment once you are done. If nothing is needed, end without replying.`,
    },
  },
  {
    id: 'triage-issues',
    title: 'Triage new issues',
    description: 'Reproduce each new issue, find the cause in the code, and comment with what you found.',
    input: {
      name: 'Triage new issues',
      triggers: [github('issue_opened')],
      instructions: `A new issue was opened.

1. Read it and find the code it is about.
2. Try to reproduce it. Note the exact steps and what happens.
3. Comment on the issue with the likely cause (files and lines), how hard a fix looks, and any question the author must answer.
4. If the fix is small and clear, open a pull request for it and link it in your comment.`,
    },
  },
  {
    id: 'update-deps',
    title: 'Update dependencies weekly',
    description: 'Every Monday, update outdated dependencies, run the tests, and open a pull request.',
    input: {
      name: 'Update dependencies',
      triggers: [schedule('week', '09:00', 1)],
      instructions: `Update this repository's outdated dependencies.

1. List the outdated packages. Skip major versions whose changelog lists breaking changes you cannot handle safely.
2. Update the rest, then install, build and run the tests.
3. Fix anything the updates broke.
4. Open one pull request that lists every update with its old and new version.`,
    },
  },
  {
    id: 'bug-sweep',
    title: 'Daily bug sweep',
    description: 'Every weekday morning, read yesterday’s commits for bugs and fix what you find.',
    input: {
      name: 'Daily bug sweep',
      triggers: [schedule('weekdays', '08:00')],
      instructions: `Look for bugs in the commits merged to the default branch in the last 24 hours.

1. Read each commit's diff. Look for logic errors, unhandled cases, broken error handling and missing tests.
2. For each real bug, write a failing test, fix it, and open a pull request.
3. If you find nothing worth fixing, end without opening anything.`,
    },
  },
  {
    id: 'changelog',
    title: 'Keep the changelog',
    description: 'When a pull request is merged, add a line for it to the changelog.',
    input: {
      name: 'Keep the changelog',
      triggers: [github('pr_merged')],
      instructions: `A pull request was just merged. Add an entry for it to the repository's changelog (CHANGELOG.md, or the file the project uses).

Write one line from the user's point of view, under the unreleased section, following the file's existing style. Open a pull request with the change. Skip pull requests that only change tests, CI or docs.`,
    },
  },
]
