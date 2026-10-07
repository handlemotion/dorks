import { createFileRoute } from '@tanstack/react-router'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { Authenticated, AuthLoading, Unauthenticated, useMutation } from 'convex/react'
import { useState } from 'react'
import { api, errorMessage, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client'
import type { Block } from '@dorks/shared'
import { authClient, convex } from '../lib/convex'

// Client-only: the Convex client needs a browser. Plain elements on purpose; styling comes later.
export const Route = createFileRoute('/dorks')({ ssr: false, component: DorksPage })

function DorksPage() {
  return (
    // authClient is cast: the component's AuthClient type does not unify with a client that also has emailOTPClient()
    <ConvexBetterAuthProvider client={convex} authClient={authClient as never}>
      <main style={{ maxWidth: 820, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
        <AuthLoading><p>Loading…</p></AuthLoading>
        <Unauthenticated><SignIn /></Unauthenticated>
        <Authenticated><Dorks /></Authenticated>
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

function Dorks() {
  const [selected, setSelected] = useState<Id<'dorks'> | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const dorks = useDorks(showArchived)
  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>Dorks</h1>
        <button onClick={() => authClient.signOut()}>Sign out</button>
      </header>
      <label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived</label>
      <ul>
        {dorks?.map((d) => (
          <li key={d._id}>
            <button onClick={() => setSelected(d._id)}>{d.title}</button> <small>{d.repo} · {d.state}{d.archived ? ' · archived' : ''}</small>
          </li>
        ))}
      </ul>
      <NewDork onCreated={setSelected} />
      {selected && <Thread dorkId={selected} />}
    </div>
  )
}

function NewDork({ onCreated }: { onCreated: (id: Id<'dorks'>) => void }) {
  const create = useMutation(api.dorks.create)
  const [repo, setRepo] = useState('jaantonio/demo')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  return (
    <form onSubmit={async (e) => { e.preventDefault(); setError(''); try { onCreated(await create({ repo, message })); setMessage('') } catch (err) { setError(errorMessage(err)) } }}>
      <input aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <input aria-label="first message" placeholder="What should it do?" value={message} onChange={(e) => setMessage(e.target.value)} />
      <button type="submit">New dork</button>
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
    </form>
  )
}

function Thread({ dorkId }: { dorkId: Id<'dorks'> }) {
  const dork = useDork(dorkId)
  const { view, canLoadMore, loadMore } = useDorkEvents(dorkId)
  const send = useMutation(api.dorks.sendMessage)
  const archive = useMutation(api.dorks.setArchived)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  if (!dork) return null
  return (
    <section aria-label="thread">
      <h2>{dork.title} <small data-testid="state">{dork.state}{dork.archived ? ' (archived)' : ''}</small></h2>
      <button onClick={() => archive({ dorkId, archived: !dork.archived })}>{dork.archived ? 'Unarchive' : 'Archive'}</button>
      {canLoadMore && <button onClick={loadMore}>Load older</button>}
      <div data-testid="transcript">{view.blocks.map((b) => <BlockView key={b.id} b={b} />)}</div>
      <form onSubmit={async (e) => { e.preventDefault(); setError(''); try { await send({ dorkId, text }); setText('') } catch (err) { setError(errorMessage(err)) } }}>
        <input aria-label="message" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Send</button>
      </form>
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
    </section>
  )
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'user': return <p><b>you:</b> {b.text}</p>
    case 'assistant': return <p><b>claude:</b> {b.text}{b.streaming ? ' ▍' : ''}</p>
    case 'tool': return <p><code>{b.name} {b.summary}</code> — {b.status}{b.preview ? `: ${b.preview}` : ''}</p>
    case 'notice': return <p style={{ color: b.level === 'error' ? 'crimson' : 'gray' }}>{b.text}</p>
  }
}
