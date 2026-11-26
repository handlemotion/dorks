import { useEffect } from 'react'
import type { DorksClient, GithubConnection } from '@dorks/client'
import { useDorksClient, useGithubConnection } from '@dorks/client/react'
import { useCloudPlace } from '../components/CloudPlace'
import { isAdminRole } from '../components/settings/access'
import { isDesktop, openExternal } from './desktop'

/**
 * GitHub for a cloud org (Teams, Cloud: the dorks-cloud Worker runs it) is the Dorks Agents GitHub App, not this Mac's GitHub CLI: an
 * owner or admin installs it on a GitHub account and picks repositories, and the new-session picker lists what it reaches.
 * Installing is a round trip through the browser (GitHub's install page, then its authorize page) that ends back where it started:
 * the desktop app by its `dorks://github?from=…` link (the shell opens `from`'s screen), a plain browser at the page it left.
 */
export type GithubFrom = 'new' | 'settings'

const returnTo = (from: GithubFrom) => (isDesktop() ? `dorks://github?from=${from}` : window.location.href)

/** Opens GitHub's page to install the Dorks Agents app for the org (or pick more repositories in it). */
export async function connectGithub(actions: DorksClient['actions'], from: GithubFrom) {
  openExternal(await actions.githubInstallUrl(returnTo(from)))
}

/** Where to add repositories: GitHub's settings page of the org's first working installation. */
export const manageUrlOf = (connection: GithubConnection | undefined) => connection?.installations.find((i) => !i.suspended && i.manageUrl)?.manageUrl

export interface CloudGithub {
  connection: GithubConnection | undefined
  /** May install the app or change it (an owner or admin of the org). */
  admin: boolean
}

/**
 * The org's GitHub App connection when the app shows a Worker-run org, else null (a Mac uses its GitHub CLI). While it is shown, the
 * window coming back to the front (from GitHub, where repositories were added) reads the connection and the repositories again.
 */
export function useCloudGithub(): CloudGithub | null {
  const place = useCloudPlace()
  const cloud = place?.target.kind === 'cloud'
  const { actions } = useDorksClient()
  const state = useGithubConnection(cloud)
  useEffect(() => {
    if (!cloud) return
    const onFocus = () => void actions.refreshGithub().catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [cloud, actions])
  if (!cloud) return null
  return { connection: state?.data, admin: isAdminRole(place?.org?.role) }
}
