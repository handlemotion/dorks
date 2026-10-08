import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client'
import type { Block } from '@dorks/shared'
import { AuthShell } from '../components/AuthShell'
import { authClient } from '../lib/convex'
import { usePending } from '../lib/pending'

// Client-only: the Convex client needs a browser. Plain elements on purpose; styling comes later.
export const Route = createFileRoute('/dorks')({ ssr: false, component: DorksPage })

function DorksPage() {
  return <AuthShell><Dorks /></AuthShell>
}

function Dorks() {
  const [selected, setSelected] = useState<Id<'dorks'> | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const dorks = useDorks(showArchived)
  const onboarding = useQuery(api.settings.onboarding)
  return (
    <div data-onboarding={onboarding ? (onboarding.claudeToken && onboarding.github ? 'complete' : 'incomplete') : 'loading'}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>Dorks</h1>
        <span><Link to="/settings">Settings</Link> <button onClick={() => authClient.signOut()}>Sign out</button></span>
      </header>
      {onboarding && !(onboarding.claudeToken && onboarding.github) && (
        <p role="status">Setup is incomplete: <Link to="/settings">finish onboarding in settings</Link> before creating a dork.</p>
      )}
      <label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived</label>
      <ul>
        {dorks?.map((d) => (
          <li key={d._id}>
            <button onClick={() => setSelected(d._id)}>{d.title}</button> <small>{d.repo} · {d.state}{d.archived ? ' · archived' : ''}</small>
          </li>
        ))}
      </ul>
      <NewDork onCreated={setSelected} />
      {selected && <Thread key={selected} dorkId={selected} />}
    </div>
  )
}

function NewDork({ onCreated }: { onCreated: (id: Id<'dorks'>) => void }) {
  const create = useMutation(api.dorks.create)
  const [repo, setRepo] = useState('jaantonio/demo')
  const [message, setMessage] = useState('')
  const { run, pending, error } = usePending()
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => { onCreated(await create({ repo, message })); setMessage('') }) }}>
      <input aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <input aria-label="first message" placeholder="What should it do?" value={message} onChange={(e) => setMessage(e.target.value)} />
      <button type="submit" disabled={pending}>{pending ? 'Creating…' : 'New dork'}</button>
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
  const { run, pending, error } = usePending()
  if (!dork) return null
  return (
    <section aria-label="thread">
      <h2>{dork.title} <small data-testid="state">{dork.state}{dork.archived ? ' (archived)' : ''}</small></h2>
      <button onClick={() => archive({ dorkId, archived: !dork.archived })}>{dork.archived ? 'Unarchive' : 'Archive'}</button>
      {canLoadMore && <button onClick={loadMore}>Load older</button>}
      <div data-testid="transcript">{view.blocks.map((b) => <BlockView key={b.id} b={b} />)}</div>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await send({ dorkId, text }); setText('') }) }}>
        <input aria-label="message" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={pending}>Send</button>
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
