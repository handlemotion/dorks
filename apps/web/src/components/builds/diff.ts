import type { BuildRepo } from '@dorks/client'

// What an agent's change differs in: a line diff of scripts, and the repositories it adds, removes or changes.

export type DiffLine = { kind: ' ' | '+' | '-'; text: string }

/** A line diff (longest common subsequence); scripts are short, so the quadratic table is fine up to a sane size. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a ? a.replace(/\n$/, '').split('\n') : []
  const y = b ? b.replace(/\n$/, '').split('\n') : []
  if (x.length * y.length > 400_000) return [...x.map((text) => ({ kind: '-' as const, text })), ...y.map((text) => ({ kind: '+' as const, text }))]
  const t = Array.from({ length: x.length + 1 }, () => Array.from({ length: y.length + 1 }, () => 0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: ' ', text: x[i] })
      i++
      j++
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: '-', text: x[i++] })
    else out.push({ kind: '+', text: y[j++] })
  }
  while (i < x.length) out.push({ kind: '-', text: x[i++] })
  while (j < y.length) out.push({ kind: '+', text: y[j++] })
  return out
}

/** Repositories the draft adds, removes or changes (branch or setup). */
export function repoChangesOf(was: BuildRepo[], now: BuildRepo[]) {
  const before = new Map(was.map((r) => [r.repo, r]))
  const after = new Map(now.map((r) => [r.repo, r]))
  return [
    ...now.filter((r) => !before.has(r.repo)).map((r) => ({ r, what: 'Added' as const })),
    ...was.filter((r) => !after.has(r.repo)).map((r) => ({ r, what: 'Removed' as const })),
    ...now
      .filter((r) => {
        const b = before.get(r.repo)
        return b && ((b.branch ?? '') !== (r.branch ?? '') || (b.setupScript ?? '') !== (r.setupScript ?? ''))
      })
      .map((r) => ({ r, what: 'Changed' as const })),
  ]
}
