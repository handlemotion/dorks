import { CatchBoundary, createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client'
import type { Block } from '@dorks/shared'
import { authClient } from '../../lib/convex'
import { usePending } from '../../lib/pending'

// The selected dork lives in the `dork` search param (not local state) so the sidebar can highlight it and the URL is shareable.
export const Route = createFileRoute('/_app/dorks')({
  validateSearch: (s: Record<string, unknown>): { dork?: string } => (typeof s.dork === 'string' ? { dork: s.dork } : {}),
  component: Dorks,
})

function Dorks() {
  // The URL is user-editable, so this is not guaranteed to be a real id: Convex rejects a malformed one, which <Thread> is wrapped for.
  const selected = Route.useSearch().dork as Id<'dorks'> | undefined
  const navigate = Route.useNavigate()
  const setSelected = (id: Id<'dorks'>) => void navigate({ search: { dork: id } })
  const [showArchived, setShowArchived] = useState(false)
  const dorks = useDorks(showArchived)
  const onboarding = useQuery(api.settings.onboarding)
  return (
    <div data-onboarding={onboarding ? (onboarding.claudeToken && onboarding.github ? 'complete' : 'incomplete') : 'loading'}>
      <header>
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
      {selected && (
        <CatchBoundary getResetKey={() => selected} errorComponent={() => <p role="alert">That dork could not be opened.</p>}>
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      )}
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
      {error && <p role="alert">{error}</p>}
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
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'user': return <p><b>you:</b> {b.text}</p>
    case 'assistant': return <p><b>claude:</b> {b.text}{b.streaming ? ' ▍' : ''}</p>
    case 'tool': return <p><code>{b.name} {b.summary}</code> — {b.status}{b.preview ? `: ${b.preview}` : ''}</p>
    case 'notice': return <p data-level={b.level}>{b.text}</p>
  }
}
