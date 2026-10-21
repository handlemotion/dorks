import { CatchBoundary, createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client'
import { DEFAULT_ENGINE, ENGINE_LABEL, type Block, type Engine } from '@dorks/shared'
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
  // Claude Code needs the Claude token; OpenCode runs on provider keys from the CLI secrets. Both need the GitHub App.
  const ready = (engine: Engine) => !!onboarding?.github && (engine !== 'claude' || onboarding.claudeToken)
  return (
    <div data-onboarding={onboarding ? (ready(onboarding.defaultEngine) ? 'complete' : 'incomplete') : 'loading'}>
      <header>
        <h1>Dorks</h1>
        <span><Link to="/settings">Settings</Link> <button onClick={() => authClient.signOut()}>Sign out</button></span>
      </header>
      {onboarding && !ready(onboarding.defaultEngine) && (
        <p role="status">Setup is incomplete: <Link to="/settings">finish onboarding in settings</Link> before creating a dork.</p>
      )}
      <label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived</label>
      <ul>
        {dorks?.map((d) => (
          <li key={d._id}>
            <button onClick={() => setSelected(d._id)}>{d.title}</button> <small>{d.repo} · {ENGINE_LABEL[d.engine ?? 'claude']} · {d.state}{d.archived ? ' · archived' : ''}</small>
          </li>
        ))}
      </ul>
      <NewDork onCreated={setSelected} defaultEngine={onboarding?.defaultEngine ?? DEFAULT_ENGINE} ready={ready} providerKey={!!onboarding?.providerKey} />
      {selected && (
        <CatchBoundary getResetKey={() => selected} errorComponent={() => <p role="alert">That dork could not be opened.</p>}>
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      )}
    </div>
  )
}

function NewDork({ onCreated, defaultEngine, ready, providerKey }: { onCreated: (id: Id<'dorks'>) => void; defaultEngine: Engine; ready: (e: Engine) => boolean; providerKey: boolean }) {
  const create = useMutation(api.dorks.create)
  const [repo, setRepo] = useState('jaantonio/demo')
  const [message, setMessage] = useState('')
  // null = follow the settings default (it loads after the first render); a pick here only applies to this dork.
  const [picked, setPicked] = useState<Engine | null>(null)
  const engine = picked ?? defaultEngine
  const { run, pending, error } = usePending()
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => { onCreated(await create({ repo, message, engine })); setMessage('') }) }}>
      <input aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <input aria-label="first message" placeholder="What should it do?" value={message} onChange={(e) => setMessage(e.target.value)} />
      <select aria-label="engine" value={engine} onChange={(e) => setPicked(e.target.value as Engine)}>
        {(Object.keys(ENGINE_LABEL) as Engine[]).map((k) => <option key={k} value={k}>{ENGINE_LABEL[k]}</option>)}
      </select>
      <button type="submit" disabled={pending}>{pending ? 'Creating…' : 'New dork'}</button>
      {!ready(engine) && <p role="status">{ENGINE_LABEL[engine]} is not set up yet: <Link to="/settings">finish onboarding in settings</Link>.</p>}
      {engine === 'opencode' && !providerKey && <p role="status" data-testid="provider-key-hint">OpenCode needs a model provider key: add one (e.g. <code>ANTHROPIC_API_KEY</code>) under CLI secrets in <Link to="/settings">settings</Link>.</p>}
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
  const engine = dork.engine ?? 'claude'
  return (
    <section aria-label="thread">
      <h2>{dork.title} <small data-testid="engine">{ENGINE_LABEL[engine]}</small> <small data-testid="state">{dork.state}{dork.archived ? ' (archived)' : ''}</small></h2>
      <button onClick={() => archive({ dorkId, archived: !dork.archived })}>{dork.archived ? 'Unarchive' : 'Archive'}</button>
      {canLoadMore && <button onClick={loadMore}>Load older</button>}
      <div data-testid="transcript">{view.blocks.map((b) => <BlockView key={b.id} b={b} engine={engine} />)}</div>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await send({ dorkId, text }); setText('') }) }}>
        <input aria-label="message" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={pending}>Send</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function BlockView({ b, engine }: { b: Block; engine: Engine }) {
  switch (b.kind) {
    case 'user': return <p><b>you:</b> {b.text}</p>
    case 'assistant': return <p><b>{engine}:</b> {b.text}{b.streaming ? ' ▍' : ''}</p>
    case 'tool': return <p><code>{b.name} {b.summary}</code> — {b.status}{b.preview ? `: ${b.preview}` : ''}</p>
    case 'notice': return <p data-level={b.level}>{b.text}</p>
  }
}
