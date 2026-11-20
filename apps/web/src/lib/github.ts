import type { GithubRepos } from '@dorks/client'

/**
 * GitHub's page for the GitHub CLI's OAuth app (gh's client id): where you grant it, or ask an owner to grant it, access to an
 * organization that restricts OAuth apps. An organization that has not granted it shows no private repositories in Dorks.
 */
export const GH_ORG_ACCESS_URL = 'https://github.com/settings/connections/applications/178c6fc778ccc68e1d6a'

/** Signs the GitHub CLI in with every scope Dorks uses (`read:org` lists organizations, `workflow` pushes CI files). */
export const GH_LOGIN_COMMAND = 'gh auth login --scopes read:org,workflow'

/** The command that adds the scopes the login lacks. */
export const scopeFixCommand = (missing: readonly string[]) => `gh auth refresh --hostname github.com --scopes ${missing.join(',')}`

/** What lacking these scopes costs, in one sentence. */
export function missingScopesText(missing: readonly string[]): string {
  const costs = [missing.includes('read:org') && 'some organizations may not be listed', missing.includes('workflow') && 'agents cannot push CI files'].filter(Boolean)
  return `Your GitHub CLI login lacks ${missing.join(' and ')}${costs.length ? `, so ${costs.join(' and ')}` : ''}.`
}

/** Plain words for a connection that is not working, or null when it is (or while loading). */
export function githubProblem(github: GithubRepos | undefined): string | null {
  switch (github?.auth.state) {
    case 'gh_missing':
      return 'The GitHub CLI isn’t installed on this computer. Install it (brew install gh), then sign in.'
    case 'gh_logged_out':
      return 'The GitHub CLI isn’t signed in.'
    case 'rejected':
      return 'GitHub rejected the GitHub CLI’s login. Sign in again.'
    case 'unreachable':
      return 'GitHub couldn’t be reached. Try again in a moment.'
    default:
      return null
  }
}
