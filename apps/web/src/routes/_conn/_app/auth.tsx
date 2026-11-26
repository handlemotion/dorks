import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { useCloudPlace } from '../../../components/CloudPlace'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { startCloudSignIn } from '../../../lib/cloudSignIn'

// The browser sign-in's way back (docs/mobile.md, "Desktop: Dorks Cloud"): the site opens `dorks://auth?code&state`, the desktop
// shell opens #/auth with them, and the home server checks the state and redeems the code. Then Settings › Account shows the account.
type Search = { code?: string; state?: string }

export const Route = createFileRoute('/_conn/_app/auth')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    code: typeof s.code === 'string' ? s.code : undefined,
    state: typeof s.state === 'string' ? s.state : undefined,
  }),
  component: AuthPage,
})

function AuthPage() {
  const { code, state } = Route.useSearch()
  const place = useCloudPlace()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const sent = useRef('')
  useEffect(() => {
    if (!place || !code || !state || sent.current === `${code}:${state}`) return
    sent.current = `${code}:${state}`
    place.home.actions.cloudFinishSignIn(code, state).then(
      () => void navigate({ to: '/settings/$page', params: { page: 'cloud' }, replace: true }),
      (e: unknown) => setError(errorMessage(e)),
    )
  }, [place?.home, code, state])
  const body =
    !code || !state || error ? (
      <EmptyState figure="relay" title="Sign-in did not finish" description={error || 'The link from the browser was incomplete.'}>
        {place && (
          <Button size="sm" variant="outline" onClick={() => void startCloudSignIn(place.home).catch((e: unknown) => setError(errorMessage(e)))}>
            Sign in again
          </Button>
        )}
      </EmptyState>
    ) : (
      <p className="text-sm text-muted-foreground">Signing in…</p>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Dorks Cloud" />
      <div className="app-main flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">{body}</div>
    </div>
  )
}
