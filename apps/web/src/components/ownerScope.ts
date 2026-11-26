import { useSyncExternalStore } from 'react'
import { ownerOf } from './RepoAvatar'

const KEY = 'dorks.owner-scope'
const listeners = new Set<() => void>()

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

let current = read()

function setOwnerScope(owner: string) {
  current = owner
  try {
    localStorage.setItem(KEY, owner)
  } catch {
    // Not remembered; the scope still applies for this page.
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * The GitHub owner the app is scoped to ('' for all), remembered per browser and shared by the sidebar's owner filter (beside the org switcher) and the new-session
 * repository picker. A scope that names no known owner falls back to all.
 */
export function useOwnerScope(owners: readonly string[]): [string, (owner: string) => void] {
  const scope = useSyncExternalStore(subscribe, () => current)
  return [owners.includes(scope) ? scope : '', setOwnerScope]
}

/**
 * The owners to switch between: the GitHub CLI login's user first, then its organizations and the owners of `repos` (the GitHub CLI
 * login's repositories and the chats', which may name an owner the login no longer reaches), alphabetical.
 */
export function ownersOf(repos: readonly string[], accounts?: { login: string | null; orgs: string[]; repos: string[] }): string[] {
  const login = accounts?.login ?? undefined
  const rest = new Set([...(accounts?.orgs ?? []), ...[...(accounts?.repos ?? []), ...repos].map(ownerOf)])
  if (login) rest.delete(login)
  return [...(login ? [login] : []), ...[...rest].filter(Boolean).sort((a, b) => a.localeCompare(b))]
}
