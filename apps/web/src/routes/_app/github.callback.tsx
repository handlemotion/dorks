import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useAction, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { api, errorCode } from '@dorks/convex/client'
import { INSTALL_STATE_KEY } from '../../lib/githubInstall'

// GitHub redirects here after "Install" with ?installation_id=…&code=…&state=…&setup_action=install ("Request user authorization (OAuth)
// during installation"). Linking is automatic only when `state` matches the value Settings generated in this browser tab AND nothing is
// linked yet; in every other case the user has to confirm, because the `code` only proves the *code's* owner can see the installation,
// not that this signed-in user asked for it (a crafted URL could otherwise swap in someone else's installation).
export const Route = createFileRoute('/_app/github/callback')({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    installation_id: typeof s.installation_id === 'string' || typeof s.installation_id === 'number' ? String(s.installation_id) : undefined,
    code: typeof s.code === 'string' ? s.code : undefined,
    state: typeof s.state === 'string' ? s.state : undefined,
  }),
  component: Callback,
})

const MESSAGES: Record<string, string> = {
  forbidden: 'This installation is not accessible to your GitHub account, so it was not linked. Install the app from the account or organization you own, or ask an owner to.',
  github_error: 'GitHub could not verify the installation (the code may have expired or been used already). Go back to settings and install again.',
  not_configured: 'GitHub App sign-in is not configured on the server (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).',
  invalid: 'GitHub sent an invalid installation id.',
}

// The code is single use: React may run the effect twice, so share one call per code until it settles.
const inflight = new Map<string, Promise<unknown>>()

function Callback() {
  const search = Route.useSearch()
  // Captured once: the code is removed from the address bar right away so it never lingers in history, logs or a screenshot.
  const [params] = useState(() => ({
    id: Number(search.installation_id),
    code: search.code,
    trusted: !!search.state && sessionStorage.getItem(INSTALL_STATE_KEY) === search.state,
  }))
  const valid = !!params.code && Number.isSafeInteger(params.id) && params.id > 0
  const link = useAction(api.settings.linkGithubInstallation)
  const onboarding = useQuery(api.settings.onboarding)
  const navigate = useNavigate()
  const [phase, setPhase] = useState<'ready' | 'linking' | 'error'>('ready')
  const [error, setError] = useState('')
  const started = useRef(false)

  useEffect(() => {
    sessionStorage.removeItem(INSTALL_STATE_KEY) // one use
    // Not a router navigation: it would race with the redirect to /settings that follows a successful link.
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])

  const doLink = () => {
    if (!valid || started.current) return
    started.current = true
    setPhase('linking')
    const key = `${params.id}:${params.code}`
    const p = inflight.get(key) ?? link({ installationId: params.id, code: params.code! })
    inflight.set(key, p)
    p.then(
      () => void navigate({ to: '/settings', replace: true }),
      (e) => { setError(MESSAGES[errorCode(e)] ?? 'Could not link the GitHub installation.'); setPhase('error') },
    ).finally(() => inflight.delete(key))
  }

  const alreadyLinked = !!onboarding?.github
  const auto = valid && params.trusted && onboarding && !alreadyLinked
  useEffect(() => { if (auto) doLink() }) // eslint-disable-line react-hooks/exhaustive-deps -- guarded by `started`

  return (
    <section>
      <h1>Linking GitHub…</h1>
      {!valid && <p role="alert">This page needs <code>installation_id</code> and <code>code</code> from GitHub. Start from settings and use the install link.</p>}
      {valid && onboarding && !auto && phase === 'ready' && (
        <div data-testid="confirm-link">
          <p role="status">
            {params.trusted
              ? <>You already have a GitHub installation linked. Linking installation <b>{params.id}</b> will <b>replace</b> it.</>
              : <>This page was not opened from the install link in your settings. Only continue if you just installed the GitHub App yourself; otherwise someone may be trying to attach their installation to your account.</>}
          </p>
          <button onClick={doLink}>Link installation {params.id}</button>
        </div>
      )}
      {phase === 'linking' && <p role="status">Verifying the installation with GitHub…</p>}
      {phase === 'error' && <p role="alert" data-testid="link-error">{error}</p>}
      <Link to="/settings">Back to settings</Link>
    </section>
  )
}
