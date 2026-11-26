import type { DorksClient } from '@dorks/client'
import { openExternal } from './desktop'

/**
 * Dorks Cloud sign-in happens in the browser (docs/mobile.md, "Desktop: Dorks Cloud"): the home server makes the site's sign-in URL
 * with a one-time state and the default browser opens it. After sign-in (and onboarding for a new account) the site hands back a
 * `dorks://auth?code&state` link, which the desktop app opens as `#/auth` to finish (routes/_conn/_app/auth.tsx).
 */
export async function startCloudSignIn(home: DorksClient): Promise<string> {
  const { url } = await home.actions.cloudStartSignIn()
  openExternal(url)
  return url
}
