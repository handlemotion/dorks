import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { ConvexReactClient } from 'convex/react'

export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)

// Cross-origin SPA -> Convex site URL: crossDomain keeps the session in localStorage instead of a cookie.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL as string,
  plugins: [emailOTPClient(), convexClient(), crossDomainClient()],
})
