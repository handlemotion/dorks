import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { Authenticated, AuthLoading, Unauthenticated } from 'convex/react'
import { useState, type ReactNode } from 'react'
import { authClient, convex } from '../lib/convex'

/** Shared by every signed-in page: Convex + auth provider, email-code sign-in when signed out. Plain elements on purpose. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    // authClient is cast: the component's AuthClient type does not unify with a client that also has emailOTPClient()
    <ConvexBetterAuthProvider client={convex} authClient={authClient as never}>
      <main style={{ maxWidth: 820, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
        <AuthLoading><p>Loading…</p></AuthLoading>
        <Unauthenticated><SignIn /></Unauthenticated>
        <Authenticated>{children}</Authenticated>
      </main>
    </ConvexBetterAuthProvider>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    setError('')
    const r = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
    if (r.error) setError(r.error.message ?? 'Could not send a code')
    else setSent(true)
  }
  const verify = async () => {
    setError('')
    const r = await authClient.signIn.emailOtp({ email, otp: code })
    if (r.error) setError(r.error.message ?? 'Invalid code')
  }
  return (
    <section>
      <h1>Sign in</h1>
      {!sent ? (
        <>
          <input aria-label="email" placeholder="you@jaantonio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button onClick={send}>Send code</button>
        </>
      ) : (
        <>
          <input aria-label="code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={verify}>Sign in</button>
        </>
      )}
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
    </section>
  )
}
