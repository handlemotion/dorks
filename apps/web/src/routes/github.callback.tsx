import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { useEffect, useState } from 'react'
import { api, errorCode } from '@dorks/convex/client'
import { AuthShell } from '../components/AuthShell'

// GitHub redirects here after "Install" with ?installation_id=…&code=…&setup_action=install ("Request user authorization (OAuth) during installation").
// The code is single use, so the link call is made at most once per code even if React runs the effect twice.
export const Route = createFileRoute('/github/callback')({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    installation_id: typeof s.installation_id === 'string' || typeof s.installation_id === 'number' ? String(s.installation_id) : undefined,
    code: typeof s.code === 'string' ? s.code : undefined,
  }),
  component: () => <AuthShell><Callback /></AuthShell>,
})

const MESSAGES: Record<string, string> = {
  forbidden: 'This installation is not accessible to your GitHub account, so it was not linked. Install the app from the account or organization you own, or ask an owner to.',
  github_error: 'GitHub could not verify the installation (the code may have expired or been used already). Go back to settings and install again.',
  not_configured: 'GitHub App sign-in is not configured on the server (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).',
  invalid: 'GitHub sent an invalid installation id.',
}

const inflight = new Map<string, Promise<unknown>>()

function Callback() {
  const { installation_id, code } = Route.useSearch()
  const link = useAction(api.settings.linkGithubInstallation)
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const id = Number(installation_id)
  const valid = !!code && Number.isSafeInteger(id) && id > 0

  useEffect(() => {
    if (!valid) return
    const key = `${id}:${code}`
    const p = inflight.get(key) ?? link({ installationId: id, code })
    inflight.set(key, p)
    let live = true
    p.then(
      () => live && void navigate({ to: '/settings', replace: true }),
      (e) => live && setError(MESSAGES[errorCode(e)] ?? 'Could not link the GitHub installation.'),
    )
    return () => { live = false }
  }, [valid, id, code, link, navigate])

  return (
    <section>
      <h1>Linking GitHub…</h1>
      {!valid && <p role="alert" style={{ color: 'crimson' }}>This page needs <code>installation_id</code> and <code>code</code> from GitHub. Start from settings and use the install link.</p>}
      {valid && !error && <p role="status">Verifying the installation with GitHub…</p>}
      {error && <p role="alert" style={{ color: 'crimson' }} data-testid="link-error">{error}</p>}
      <Link to="/settings">Back to settings</Link>
    </section>
  )
}
