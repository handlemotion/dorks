import { CatchBoundary, createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ChevronDownIcon, InfoIcon } from 'lucide-react'
import { useConnection, useDork, useDorkEvents, useDorks, useDorksClient, useSettings } from '@dorks/client/react'
import { AgentStatus } from '../../../components/AgentStatus'
import { Alert, AlertDescription } from '@dorks/ui/alert'
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
import { ChatDetails, ChatSplit, ShowDetailsButton, useDetailsOpen } from '../../../components/ChatDetails'
import { Composer, type AgentProvider } from '../../../components/ChatComposer'
import { ChatMenu } from '../../../components/ChatMenu'
import { ArchiveButton, PageHeader } from '../../../components/PageHeader'
import { SetupStatus } from '../../../components/SetupStatus'
import { canCreate, onboarded } from '../../../lib/onboarding'
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
  // First run: the owner answers onboarding (Boat, an agent, GitHub) first. The snapshot may still be building: the page says so.
  if (settings && !onboarded(settings)) return <Navigate to="/onboarding" replace />
  const ready = !!settings && canCreate(settings)

  return (
    <div className="flex h-full min-h-0 flex-col" data-onboarding={settings ? (ready ? 'complete' : 'preparing') : 'loading'}>
      {!selected && (
        <PageHeader
          title="Dorks"
          subtitle="Give your agent a task and follow its work here."
          actions={<Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/settings" />}>Settings</Button>}
        />
      )}
      {settings && ready && !settings.claudeToken && (
        <Notice>Add a <Link to="/settings" className="font-medium underline underline-offset-4">Claude token</Link> to start sessions with Claude Code.</Notice>
      )}
      {selected ? (
        <CatchBoundary getResetKey={() => selected} errorComponent={() => <p className="mx-auto mt-6 text-sm text-destructive" role="alert">That session could not be opened.</p>}>
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center gap-8 overflow-y-auto px-4 py-8">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">What should we work on?</h2>
            <p className="text-sm text-muted-foreground">Choose a repository, then describe the change you want.</p>
          </div>
          {settings && <SetupStatus settings={settings} />}
          <NewDork onCreated={setSelected} disabled={!ready} claudeReady={!!settings?.claudeToken} codexReady={!!settings?.boatEnvironment} />
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

function NewDork({ onCreated, disabled, claudeReady, codexReady }: { onCreated: (id: string) => void; disabled: boolean; claudeReady: boolean; codexReady: boolean }) {
  const { actions } = useDorksClient()
  const [repo, setRepo] = useState('acme/demo')
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const { run, pending, error } = usePending()
  const needsClaudeToken = provider === 'claude' && !claudeReady
  return (
    <div className="-mx-4">
      {needsClaudeToken && <p className="mx-4 mb-2 text-sm text-destructive" role="status">Add a <Link to="/settings" className="font-medium underline underline-offset-4">Claude token in settings</Link> to use Claude Code.</p>}
      <Composer
        text={message} setText={setMessage} repo={repo} setRepo={setRepo} provider={provider} setProvider={setProvider} codexEnabled={codexReady}
        pending={pending} disabled={disabled || needsClaudeToken} error={error}
        onSubmit={() => void run(async () => { onCreated((await actions.createDork({ repo: repo.trim(), message, provider })).id); setMessage('') })}
      />
    </div>
  )
}

function Thread({ dorkId }: { dorkId: string }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
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
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()
  const { live } = useConnection()
  if (dork === undefined || loading) return <p className="mt-4 px-6 text-sm text-muted-foreground" role="status">Loading session…</p>
  if (dork === null) return <p className="mt-4 px-6 text-sm text-destructive" role="alert">That session could not be found.</p>
  return (
    <ChatSplit details={detailsOpen ? <ChatDetails data={{ pr: prOf(dork.prUrl) }} onClose={() => setDetailsOpen(false)} onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)} onAsk={setText} /> : undefined}>
    <section className="flex min-w-0 flex-1 flex-col" aria-label="thread" data-state={dork.state}>
      <PageHeader divider={false}
        title={dork.title}
        titleActions={<ArchiveButton archived={dork.archived} disabled={archiving} onClick={() => void runArchive(() => actions.archiveDork(dorkId, !dork.archived))} />}
        actions={<>
          <ChatMenu prUrl={dork.prUrl} onDelete={async () => { await actions.deleteDork(dorkId); await navigate({ to: '/dorks', search: {} }) }} />
          {!detailsOpen && <ShowDetailsButton onClick={() => setDetailsOpen(true)} />}
        </>}
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
          <MessageScrollerViewport aria-label="Session transcript" className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-[30px] py-6" data-testid="transcript">
              {canLoadMore && <div className="text-center"><Button variant="outline" size="sm" onClick={loadMore}>Load older</Button></div>}
              <ChatMessages blocks={view.blocks} />
              {/* In the transcript, not pinned over it: scrolled up, the scroll-to-end button takes its place. */}
              <AgentStatus state={dork.state} live={live} />
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
    </ChatSplit>
  )
}

/** The pull request from the stored url; the number is read from it, since the backend does not keep it separately. */
function prOf(url: string | undefined) {
  if (!url) return undefined
  const n = /\/pull\/(\d+)/.exec(url)?.[1]
  return { url, number: n ? Number(n) : undefined }
}
