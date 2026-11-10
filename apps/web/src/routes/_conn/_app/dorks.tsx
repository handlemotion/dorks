import { CatchBoundary, createFileRoute, Link, Navigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, InfoIcon, PlusIcon } from 'lucide-react'
import { useDork, useDorkEvents, useDorks, useDorksClient, useSettings } from '@dorks/client/react'
import { Alert, AlertDescription } from '@dorks/ui/alert'
import { Badge } from '@dorks/ui/badge'
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
import { ChatMessages } from '../../../components/ChatBlock'
import { Composer, type AgentProvider } from '../../../components/ChatComposer'
import { PageHeader } from '../../../components/PageHeader'
import { canCreate } from '../../../lib/onboarding'
import { usePending } from '../../../lib/pending'

// The selected dork lives in the `dork` search param (not local state) so the sidebar can highlight it and the URL is shareable.
export const Route = createFileRoute('/_conn/_app/dorks')({
  validateSearch: (s: Record<string, unknown>): { dork?: string } => (typeof s.dork === 'string' ? { dork: s.dork } : {}),
  component: Dorks,
})

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="mx-auto mt-3 w-full max-w-3xl" role="status">
      <InfoIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function Dorks() {
  // The URL is user-editable, so this is not guaranteed to be a real id: the server answers not_found, which <Thread> shows.
  const selected = Route.useSearch().dork
  const navigate = Route.useNavigate()
  const setSelected = (id: string) => void navigate({ search: { dork: id } })
  const [showArchived, setShowArchived] = useState(false)
  const dorks = useDorks(showArchived)
  const settings = useSettings()
  const ready = !!settings && canCreate(settings)
  // First run: a session needs a Boat key, a snapshot and a GitHub token, so the owner finishes onboarding first.
  if (settings && !ready) return <Navigate to="/onboarding" replace />

  return (
    <div className="flex h-full min-h-0 flex-col" data-onboarding={settings ? (ready ? 'complete' : 'incomplete') : 'loading'}>
      {!selected && (
        <PageHeader
          title="Dorks"
          subtitle="Give your agent a task and follow its work here."
          actions={<Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/settings" />}>Settings</Button>}
        />
      )}
      {settings && ready && !settings.boatEnvironment && (
        <Notice>For cloud Codex sessions, <Link to="/settings" className="font-medium underline underline-offset-4">connect ChatGPT to your Boat account once</Link>.</Notice>
      )}
      {settings && ready && !settings.publicUrlConfigured && (
        <Notice>Sandboxes cannot reach this machine yet: no public URL is configured. Sessions will not start until the tunnel is up.</Notice>
      )}
      {selected ? (
        <CatchBoundary getResetKey={() => selected} errorComponent={() => <p className="mx-auto mt-6 text-sm text-destructive" role="alert">That session could not be opened.</p>}>
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center gap-8 overflow-y-auto px-4 py-8">
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight">What should we work on?</h2>
            <p className="text-muted-foreground">Choose a repository and agent, then describe the change you want.</p>
          </div>
          <NewDork onCreated={setSelected} disabled={!ready} claudeReady={!!settings?.claudeToken} />
          <div className="self-start text-sm text-muted-foreground">
            <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </Button>
            {showArchived && (
              <ul aria-label="Archived sessions" className="mt-2 flex max-h-44 flex-col overflow-y-auto">
                {dorks?.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => setSelected(d.id)}>{d.title}</Button>
                    <span className="truncate text-xs">{d.repo}</span>
                  </li>
                ))}
                {dorks?.length === 0 && <li>No archived sessions.</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NewDork({ onCreated, disabled, claudeReady }: { onCreated: (id: string) => void; disabled: boolean; claudeReady: boolean }) {
  const { actions } = useDorksClient()
  const [repo, setRepo] = useState('acme/demo')
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<AgentProvider>('codex')
  const { run, pending, error } = usePending()
  const needsClaudeToken = provider === 'claude' && !claudeReady
  return (
    <div className="-mx-4">
      {needsClaudeToken && <p className="mx-4 mb-2 text-sm text-destructive" role="status">Add a <Link to="/settings" className="font-medium underline underline-offset-4">Claude token in settings</Link> to use Claude Code.</p>}
      <Composer
        text={message} setText={setMessage} repo={repo} setRepo={setRepo} provider={provider} setProvider={setProvider}
        pending={pending} disabled={disabled || needsClaudeToken} error={error}
        onSubmit={() => void run(async () => { onCreated((await actions.createDork({ repo: repo.trim(), message, provider })).id); setMessage('') })}
      />
    </div>
  )
}

function Thread({ dorkId }: { dorkId: string }) {
  const { actions } = useDorksClient()
  const dork = useDork(dorkId)
  const { view, canLoadMore, loadMore, loading, send } = useDorkEvents(dorkId)
  const [text, setText] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const { run, pending, error } = usePending()
  const { run: runStop, pending: stopping, error: stopError } = usePending()
  const { run: runArchive, pending: archiving, error: archiveError } = usePending()
  const modelChoice = usePending()
  const models = dork?.codexModelChoices?.flatMap((option) => option.efforts.map((effort) => ({
    key: `${option.model}:${effort}`, model: option.model, effort,
  }))) ?? []
  const choice = models.find((option) => option.key === selectedModel) ?? models[0]
  const working = dork?.state === 'working'
  if (dork === undefined || loading) return <p className="mt-4 px-6 text-sm text-muted-foreground" role="status">Loading session…</p>
  if (dork === null) return <p className="mt-4 px-6 text-sm text-destructive" role="alert">That session could not be found.</p>
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="thread">
      <PageHeader
        title={dork.title}
        subtitle={<>{dork.repo} · <Badge variant="outline" data-testid="state" className="align-middle">{dork.state}{dork.archived ? ' (archived)' : ''}</Badge></>}
        actions={
          <>
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/dorks" search={{}} />}><PlusIcon />New session</Button>
            <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void runArchive(() => actions.archiveDork(dorkId, !dork.archived))}>
              {dork.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {dork.archived ? 'Unarchive' : 'Archive'}
            </Button>
          </>
        }
      />
      {models.length > 0 && (
        <form className="mx-auto mt-4 flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 px-4 text-sm" onSubmit={(event) => {
          event.preventDefault()
          if (choice) void modelChoice.run(() => actions.chooseCodexModel(dorkId, choice.model, choice.effort))
        }}>
          <span className="w-full text-muted-foreground">Available ChatGPT models</span>
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
          {modelChoice.error && <p className="text-sm text-destructive" role="alert">{modelChoice.error}</p>}
        </form>
      )}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label="Session transcript">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-8 py-8" data-testid="transcript">
              {canLoadMore && <div className="text-center"><Button variant="outline" size="sm" onClick={loadMore}>Load older</Button></div>}
              <ChatMessages blocks={view.blocks} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer
        text={text} setText={setText} provider={dork.provider ?? 'claude'} pending={pending} disabled={dork.archived} error={error || stopError || archiveError}
        onSubmit={() => void run(async () => {
          const sent = text
          setText('') // the optimistic row shows it at once; put it back if the server refuses
          try { await send(sent) } catch (e) { setText(sent); throw e }
        })}
        onStop={working && !stopping && !dork.archived ? () => void runStop(() => actions.interrupt(dorkId)) : undefined}
      />
    </section>
  )
}
