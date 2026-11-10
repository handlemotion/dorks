import { CatchBoundary, createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { api, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client'
import { Button } from '@dorks/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupButton } from '@dorks/ui/input-group'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@dorks/ui/message-scroller'
import { ChatMessages } from '../../components/ChatBlock'
import { Composer, type AgentProvider } from '../../components/ChatComposer'
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
  const ready = !!onboarding?.github

  return (
    <div className="dorks-page" data-onboarding={onboarding ? (ready ? 'complete' : 'incomplete') : 'loading'}>
      <header className="dorks-header">
        <div>
          <h1>{selected ? 'Session' : 'Dorks'}</h1>
          {!selected && <p>Give your agent a task and follow its work here.</p>}
        </div>
        <div className="dorks-header-actions">
          {selected && <Button variant="ghost" size="sm" render={<Link to="/dorks" search={{}} />}>New session</Button>}
          <Button variant="ghost" size="sm" render={<Link to="/settings" />}>Settings</Button>
          <Button variant="ghost" size="sm" onClick={() => void authClient.signOut()}>Sign out</Button>
        </div>
      </header>
      {onboarding && !ready && (
        <p className="dorks-setup" role="status">
          Setup is incomplete. <Link to="/settings">Finish onboarding in settings</Link> before creating a session.
        </p>
      )}
      {onboarding?.github && !onboarding.codexBoatEnvironment && (
        <p className="dorks-setup" role="status">
          For cloud Codex sessions, <Link to="/settings">connect ChatGPT to your Boat account once</Link>.
        </p>
      )}
      {selected ? (
        <CatchBoundary getResetKey={() => selected} errorComponent={() => <p className="dorks-error" role="alert">That session could not be opened.</p>}>
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      ) : (
        <div className="dorks-empty">
          <div className="dorks-empty-body">
            <h2>What should we work on?</h2>
            <p>Choose a repository and agent, then describe the change you want.</p>
          </div>
          <NewDork onCreated={setSelected} disabled={!ready} claudeReady={!!onboarding?.claudeToken} />
          <div className="dorks-history">
            <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </Button>
            {showArchived && (
              <ul aria-label="Archived sessions">
                {dorks?.map((d) => <li key={d._id}><Button variant="ghost" onClick={() => setSelected(d._id)}>{d.title}</Button><span>{d.repo}</span></li>)}
                {dorks?.length === 0 && <li>No archived sessions.</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NewDork({ onCreated, disabled, claudeReady }: { onCreated: (id: Id<'dorks'>) => void; disabled: boolean; claudeReady: boolean }) {
  const create = useMutation(api.dorks.create)
  const [repo, setRepo] = useState('acme/demo')
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<AgentProvider>('codex')
  const { run, pending, error } = usePending()
  const needsClaudeToken = provider === 'claude' && !claudeReady
  return (
    <>
      {needsClaudeToken && <p className="dorks-error" role="status">Add a <Link to="/settings">Claude token in settings</Link> to use Claude Code.</p>}
      <Composer
        text={message} setText={setMessage} repo={repo} setRepo={setRepo} provider={provider} setProvider={setProvider}
        pending={pending} disabled={disabled || needsClaudeToken} error={error}
        onSubmit={() => void run(async () => { onCreated(await create({ repo: repo.trim(), message, provider })); setMessage('') })}
      />
    </>
  )
}

function Thread({ dorkId }: { dorkId: Id<'dorks'> }) {
  const dork = useDork(dorkId)
  const { view, canLoadMore, loadMore, loading } = useDorkEvents(dorkId)
  const send = useMutation(api.dorks.sendMessage)
  const interrupt = useMutation(api.dorks.interrupt)
  const archive = useMutation(api.dorks.setArchived)
  const chooseModel = useMutation(api.dorks.chooseCodexModel)
  const reconnect = useMutation(api.dorks.reconnectCodex)
  const [text, setText] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const { run, pending, error } = usePending()
  const { run: runStop, pending: stopping, error: stopError } = usePending()
  const { run: runArchive, pending: archiving, error: archiveError } = usePending()
  const modelChoice = usePending()
  const reconnecting = usePending()
  const models = dork?.codexModelChoices?.flatMap((option) => option.efforts.map((effort) => ({
    key: `${option.model}:${effort}`, model: option.model, effort,
  }))) ?? []
  const choice = models.find((option) => option.key === selectedModel) ?? models[0]
  const working = dork?.state === 'working'
  if (dork === undefined || loading) return <p className="dorks-loading" role="status">Loading session…</p>
  if (dork === null) return <p className="dorks-error" role="alert">That session could not be found.</p>
  return (
    <section className="dorks-thread" aria-label="thread">
      <div className="dorks-thread-header">
        <div>
          <h2>{dork.title}</h2>
          <p>{dork.repo} · <span data-testid="state">{dork.state}{dork.archived ? ' (archived)' : ''}</span></p>
        </div>
        <div className="dorks-thread-actions">
          {dork.provider === 'codex' && dork.codexAuthSource !== 'boat' && (
            <Button className="dorks-reconnect" variant="outline" size="sm" disabled={dork.state !== 'idle' || reconnecting.pending} onClick={() => {
              if (window.confirm('Sign out of ChatGPT in this sandbox and get a new sign-in code?'))
                void reconnecting.run(() => reconnect({ dorkId }))
            }}>{reconnecting.pending ? 'Disconnecting…' : 'Reconnect ChatGPT'}</Button>
          )}
          <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void runArchive(() => archive({ dorkId, archived: !dork.archived }))}>{dork.archived ? 'Unarchive' : 'Archive'}</Button>
        </div>
      </div>
      {reconnecting.error && <p className="dorks-agent-error" role="alert">{reconnecting.error}</p>}
      {dork.codexAuthSource !== 'boat' && dork.codexLogin && (
        <div className="dorks-agent-frame">
          <div className="dorks-agent-notice" role="status">
            <p>Connect ChatGPT to this sandbox. Enable Codex device-code sign-in in ChatGPT settings if needed.</p>
            <p>Enter <strong>{dork.codexLogin.userCode}</strong> at <a href={dork.codexLogin.verificationUrl} target="_blank" rel="noreferrer">the ChatGPT verification page</a>.</p>
            <p>This code signs in only this sandbox. It disappears after you connect.</p>
          </div>
        </div>
      )}
      {models.length > 0 && (
        <form className="dorks-agent-frame dorks-model-form" onSubmit={(event) => {
          event.preventDefault()
          if (choice) void modelChoice.run(() => chooseModel({ dorkId, model: choice.model, effort: choice.effort }))
        }}>
          <span className="dorks-model-label">Available ChatGPT models</span>
          <InputGroup className="max-w-56">
            <DropdownMenu>
              <DropdownMenuTrigger render={<InputGroupButton size="sm" variant="ghost" className="w-full justify-between" aria-label="Codex model" />}>
                <span className="truncate">{choice ? `${choice.model} · ${choice.effort}` : 'Choose model'}</span>
                <ChevronDownIcon className="shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Model and effort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={choice?.key ?? ''} onValueChange={setSelectedModel}>
                    {models.map((option) => (
                      <DropdownMenuRadioItem key={option.key} value={option.key}>
                        {option.model} · {option.effort}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </InputGroup>
          <Button type="submit" size="sm" disabled={dork.state !== 'error' || modelChoice.pending || !choice}>
            {modelChoice.pending ? 'Starting…' : 'Use this model'}
          </Button>
          {modelChoice.error && <p className="dorks-error" role="alert">{modelChoice.error}</p>}
        </form>
      )}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label="Session transcript">
            <MessageScrollerContent className="dorks-transcript gap-6" data-testid="transcript">
              {canLoadMore && <div className="dorks-older"><Button variant="outline" size="sm" onClick={loadMore}>Load older</Button></div>}
              <ChatMessages blocks={view.blocks} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer
        text={text} setText={setText} provider={dork.provider ?? 'claude'} pending={pending} disabled={dork.archived} error={error || stopError || archiveError}
        onSubmit={() => void run(async () => { await send({ dorkId, text }); setText('') })}
        onStop={working && !stopping && !dork.archived ? () => void runStop(() => interrupt({ dorkId })) : undefined}
      />
    </section>
  )
}
