import { expect, it } from 'vite-plus/test'
import { stackOf, stackOrder, stackRoot } from './prStack'

const pr = (number: number, headRef: string, baseRef: string, repo = 'acme/app') => ({ url: `https://github.com/${repo}/pull/${number}`, title: `#${number}`, repo, number, headRef, baseRef })

// Stacks nest by branch within one repo, a branch cycle still lists every PR, and a lone PR has no stack.
it('orders stacked PRs under their base, scoped to the repo, and survives a branch cycle', () => {
  const prs = stackOrder([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(4, 'd', 'main'), pr(5, 'x', 'a', 'acme/other'), pr(6, 'p', 'q'), pr(7, 'q', 'p')])
  expect(prs.map((p) => [p.number, p.depth])).toEqual([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 1],
  ])
  expect(stackOf(prs, prs[2].url)?.map((e) => [e.number, e.current])).toEqual([
    [1, false],
    [2, false],
    [3, true],
  ])
  expect(stackOf(prs, prs[3].url)).toBeUndefined()
  // A stack's PRs share one tab, named for its root; a lone PR keeps its own.
  expect([prs[1].url, prs[2].url].map((u) => stackRoot(prs, u))).toEqual([prs[0].url, prs[0].url])
  expect(stackRoot(prs, prs[3].url)).toBeUndefined()
})
