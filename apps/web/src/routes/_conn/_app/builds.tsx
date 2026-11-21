import { createFileRoute } from '@tanstack/react-router'
import { BuildList } from '../../../components/builds/BuildList'
import { BuildPage } from '../../../components/builds/BuildPage'

// Builds (docs/builds.md): named machine setups a session can start from. Four pages on one route, laid out with the settings kit:
// the list (`/builds`), a build (`?build=<id>`), one of its runs with the log (`&run=<id>`), and an agent's change to review (`&review=<draft id>`).
// The pages and their pieces live in components/builds; this file only reads the search and picks one.

type Search = { build?: string; run?: string; review?: string }

export const Route = createFileRoute('/_conn/_app/builds')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {}
    for (const k of ['build', 'run', 'review'] as const) if (typeof s[k] === 'string') out[k] = s[k] as string
    return out
  },
  component: Builds,
})

function Builds() {
  const { build, run, review } = Route.useSearch()
  if (!build) return <BuildList />
  return <BuildPage id={build} run={run} review={review} />
}
