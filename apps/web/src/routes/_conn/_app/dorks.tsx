import { CatchBoundary, createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import type { DesktopOptions } from '@dorks/client'
import type { AgentModelChoice } from '@dorks/shared'
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, MessageSquareIcon } from 'lucide-react'
import { useBuilds, useConnection, useDork, useDorkEvents, useDorks, useDorksClient, useSettings } from '@dorks/client/react'
import { List } from '../../../components/onboarding/List'
import { EmptyState } from '../../../components/EmptyState'
import { AgentStatus } from '../../../components/AgentStatus'
import { BrandCircle } from '../../../components/BrandCircle'
import { Alert, AlertDescription } from '@dorks/ui/alert'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupButton } from '@dorks/ui/input-group'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@dorks/ui/message-scroller'
import { ChatMessages } from '../../../components/ChatBlock'
import { ChatDetails, ChatSplit, ShowDetailsButton, useDetailsOpen, type ChatDetailsData } from '../../../components/ChatDetails'
import { withImages, Composer, type AgentProvider, type ModelPicker } from '../../../components/ChatComposer'
import { ChatMenu } from '../../../components/ChatMenu'
import { ArchiveButton, PageHeader } from '../../../components/PageHeader'
import { SetupStatus } from '../../../components/SetupStatus'
import { canCreate, onboarded } from '../../../lib/onboarding'
import { usePending } from '../../../lib/pending'
import { withReply, type Reply } from '../../../lib/reply'

// The selected dork lives in the `dork` search param (not local state) so the sidebar can highlight it and the URL is shareable.
export const Route = createFileRoute('/_conn/_app/dorks')({
  // `repo` preselects the new session's repository (the sidebar's + beside a repository group).
  validateSearch: (s: Record<string, unknown>): { dork?: string; repo?: string } => ({
    ...(typeof s.dork === 'string' ? { dork: s.dork } : {}),
    ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
  }),
  component: Dorks,
})

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="mx-auto mt-3 w-full max-w-4xl" role="status">
      <InfoIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function Dorks() {
  // The URL is user-editable, so this is not guaranteed to be a real id: the server answers not_found, which <Thread> shows.
  const { dork: selected, repo: presetRepo } = Route.useSearch()
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
      {!selected && <PageHeader title="New session" divider={false} />}
      {settings && ready && !settings.claudeToken && (
        <Notice>
          Add a{' '}
          <Link to="/settings" className="font-medium underline underline-offset-4">
            Claude token
          </Link>{' '}
          to start sessions with Claude Code.
        </Notice>
      )}
      {selected ? (
        <CatchBoundary
          getResetKey={() => selected}
          errorComponent={() => (
            <p className="mx-auto mt-6 text-sm text-destructive" role="alert">
              That session could not be opened.
            </p>
          )}
        >
          <Thread key={selected} dorkId={selected} />
        </CatchBoundary>
      ) : (
        <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-clip" data-testid="new-session">
          <BrandCircle className="w-[124.54%]" />
          <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto py-12">
            {showArchived && (
              <section aria-label="Archived sessions" className="mx-auto flex min-h-0 w-full max-w-[790px] flex-col gap-6 px-5">
                <h2 className="text-center text-lg font-medium">Archived sessions</h2>
                {dorks === undefined ? (
                  <p role="status" className="text-center text-sm text-muted-foreground">
                    Loading sessions…
                  </p>
                ) : dorks.length === 0 ? (
                  <EmptyState figure="drawer" title="No archived sessions" description="Sessions you archive will show up here." />
                ) : (
                  <div className="overflow-y-auto">
                    <List>
                      {dorks.map((d) => (
                        <li key={d.id}>
                          <button type="button" onClick={() => setSelected(d.id)} className="flex h-12 w-full items-center gap-3 px-4 text-left outline-none hover:bg-muted focus-visible:bg-muted">
                            <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{d.title}</span>
                            <span className="max-w-[35%] truncate text-xs text-muted-foreground">{d.repo}</span>
                            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          </button>
                        </li>
                      ))}
                    </List>
                  </div>
                )}
              </section>
            )}
            <div className={`${showArchived ? 'hidden' : 'flex'} mx-auto w-full max-w-[790px] flex-col gap-6`}>
              <h2 className="sr-only">What should we work on?</h2>
              {settings && (
                <div className="px-5 [&:has(>div:empty)]:hidden">
                  <SetupStatus settings={settings} />
                </div>
              )}
              <NewDork key={presetRepo} initialRepo={presetRepo} onCreated={setSelected} disabled={!ready} claudeReady={!!settings?.claudeToken} codexReady={!!settings?.boatEnvironment} />
            </div>
          </div>
          <div className="shrink-0 self-center px-5 pb-3 text-sm text-muted-foreground">
            <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function NewDork({
  initialRepo,
  onCreated,
  disabled,
  claudeReady,
  codexReady,
}: {
  initialRepo?: string
  onCreated: (id: string) => void
  disabled: boolean
  claudeReady: boolean
  codexReady: boolean
}) {
  const { actions } = useDorksClient()
  const settings = useSettings()
  // Sent with the first message (the server checks it against the models the agent reported), then kept by the session.
  const [choice, setChoice] = useState<{ model?: string; effort?: string }>({})
  const dorks = useDorks()
  const builds = useBuilds()
  const built = (builds ?? []).filter((b) => b.image).map((b) => ({ id: b.id, name: b.name, repos: b.repos.map((r) => r.repo) }))
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  // Until the owner picks one: the default build when it is built, else the base machine.
  const buildId = picked !== undefined ? picked : built.some((b) => b.id === settings?.defaultBuildId) ? (settings?.defaultBuildId ?? null) : null
  const buildRepos = built.find((b) => b.id === buildId)?.repos ?? []
  const repositories = [...new Set([...buildRepos, ...[...new Set(dorks?.map((d) => d.repo).filter(Boolean) ?? [])].sort()])]
  const [repo, setRepo] = useState(initialRepo ?? 'acme/demo')
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<AgentProvider>(claudeReady ? 'claude' : codexReady ? 'codex' : 'claude')
  const { run, pending, error } = usePending()
  const needsClaudeToken = provider === 'claude' && !claudeReady
  return (
    <div className="[&>div]:max-w-none">
      {needsClaudeToken && (
        <p className="mx-5 mb-2 text-sm text-destructive" role="status">
          Add a{' '}
          <Link to="/settings" className="font-medium underline underline-offset-4">
            Claude token in settings
          </Link>{' '}
          to use Claude Code.
        </p>
      )}
      <Composer
        text={message}
        setText={setMessage}
        repo={repo}
        setRepo={setRepo}
        repositories={repositories}
        provider={provider}
        setProvider={setProvider}
        codexEnabled={codexReady}
        pending={pending}
        disabled={disabled || needsClaudeToken}
        error={error}
        picker={{ choices: settings?.claudeModels ?? [], ...choice, onChange: (model, effort) => setChoice({ model, effort }) }}
        upload={actions.uploadImage}
        machine={{ builds: built, buildId, onChange: setPicked }}
        onSubmit={(images) =>
          run(async () => {
            onCreated((await actions.createDork({ repo: repo.trim(), message: withImages(message, images), provider, buildId, ...(provider === 'claude' ? choice : {}) })).id)
            setMessage('')
          })
        }
      />
    </div>
  )
}

type DorkView = NonNullable<ReturnType<typeof useDork>>
type DorksActions = ReturnType<typeof useDorksClient>['actions']

/** Chat details for a session: its pull request, screenshots (newest first), previews and computer. */
function detailsData(dork: DorkView, actions: DorksActions, computer: Pick<NonNullable<ChatDetailsData['computer']>, 'used' | 'fetchUrl' | 'interrupt'>): ChatDetailsData {
  return {
    pr: prOf(dork.prUrl),
    artifacts: dork.images?.map((i, n) => ({ id: i.id, name: i.caption ?? `Screenshot ${n + 1}`, type: 'Screenshot', src: actions.imageUrl(i.id), width: i.width, height: i.height })).reverse(),
    previews: dork.previews?.map((p) => ({ name: p.title ?? `Port ${p.port}`, url: p.url, port: p.port })),
    computer: { awake: dork.state === 'working' || dork.state === 'idle', working: dork.state === 'working', ...computer },
  }
}

/** Claude's model menu for a running session; Codex has none. */
function claudePicker(dork: DorkView, fallback: AgentModelChoice[] | undefined, onChange: ModelPicker['onChange']): ModelPicker | undefined {
  if (dork.provider !== 'claude') return undefined
  return {
    choices: dork.modelChoices ?? fallback ?? [],
    model: dork.model,
    effort: dork.effort,
    active: { model: dork.agentModel, effort: dork.agentEffort },
    onChange,
  }
}

/** A failed Codex session's ChatGPT models, to restart it on another one. */
function CodexModelForm({ dork }: { dork: DorkView }) {
  const { actions } = useDorksClient()
  const [selectedModel, setSelectedModel] = useState('')
  const modelChoice = usePending()
  const models =
    dork.codexModelChoices?.flatMap((option) =>
      option.efforts.map((effort) => ({
        key: `${option.model}:${effort}`,
        model: option.model,
        effort,
      })),
    ) ?? []
  const choice = models.find((option) => option.key === selectedModel) ?? models[0]
  if (models.length === 0) return null
  return (
    <form
      className="mx-auto mt-4 flex w-full max-w-4xl shrink-0 flex-wrap items-center gap-2 px-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault()
        if (choice) void modelChoice.run(() => actions.chooseCodexModel(dork.id, choice.model, choice.effort))
      }}
    >
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
      {modelChoice.error && (
        <p className="text-sm text-destructive" role="alert">
          {modelChoice.error}
        </p>
      )}
    </form>
  )
}

function Thread({ dorkId }: { dorkId: string }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const dork = useDork(dorkId)
  const { view, canLoadMore, loadMore, loading, error: eventsError, send } = useDorkEvents(dorkId)
  const [text, setText] = useState('')
  const [reply, setReply] = useState<Reply>()
  const { run, pending, error } = usePending()
  const { run: runStop, pending: stopping, error: stopError } = usePending()
  const { run: runArchive, pending: archiving, error: archiveError } = usePending()
  const modelSwitch = usePending()
  const settings = useSettings()
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()
  const computerUsed = view.blocks.some((b) => b.kind === 'tool' && b.name.startsWith('mcp__computer__'))
  const fetchDesktopUrl = useCallback((opts: DesktopOptions) => actions.desktopUrl(dorkId, opts), [actions, dorkId])
  const interruptAgent = useCallback(() => actions.interrupt(dorkId), [actions, dorkId])
  const { live } = useConnection()
  if (dork === undefined || loading)
    return (
      <p className="mt-4 px-6 text-sm text-muted-foreground" role="status">
        Loading session…
      </p>
    )
  if (dork === null)
    return (
      <p className="mt-4 px-6 text-sm text-destructive" role="alert">
        That session could not be found.
      </p>
    )
  const working = dork.state === 'working'
  const canReply = !dork.archived
  return (
    <ChatSplit
      details={
        detailsOpen ? (
          <ChatDetails
            data={detailsData(dork, actions, { used: computerUsed, fetchUrl: fetchDesktopUrl, interrupt: interruptAgent })}
            onClose={() => setDetailsOpen(false)}
            onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)}
            onAsk={setText}
          />
        ) : undefined
      }
    >
      <section className="flex min-w-0 flex-1 flex-col" aria-label="thread" data-state={dork.state}>
        <PageHeader
          divider={false}
          title={dork.title}
          titleActions={<ArchiveButton archived={dork.archived} disabled={archiving} onClick={() => void runArchive(() => actions.archiveDork(dorkId, !dork.archived))} />}
          actions={
            <>
              <ChatMenu
                prUrl={dork.prUrl}
                detailsOpen={detailsOpen}
                onDelete={async () => {
                  await actions.deleteDork(dorkId)
                  await navigate({ to: '/dorks', search: {} })
                }}
              />
              {!detailsOpen && <ShowDetailsButton onClick={() => setDetailsOpen(true)} />}
            </>
          }
        />
        <CodexModelForm dork={dork} />
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport aria-label="Session transcript" className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
              <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-6 px-10 pt-6 pb-12" data-testid="transcript">
                {canLoadMore && (
                  <div className="text-center">
                    <Button variant="outline" size="sm" onClick={loadMore}>
                      Load older
                    </Button>
                  </div>
                )}
                <ChatMessages
                  blocks={view.blocks}
                  imageUrl={actions.imageUrl}
                  agent={dork.provider === 'codex' ? 'Codex' : 'Claude'}
                  onReply={
                    canReply
                      ? (quoted, draft) => {
                          setReply(quoted)
                          if (draft) setText((t) => (t.trim() ? `${t}\n\n${draft}` : draft))
                        }
                      : undefined
                  }
                  onReplySend={canReply ? (quoted, answer) => run(() => send(withReply(quoted, answer))) : undefined}
                />
                {eventsError && (
                  <p role="alert" className="text-sm text-destructive">
                    Could not load messages: {eventsError.message}. Retrying…
                  </p>
                )}
                <div>
                  <AgentStatus state={dork.state} live={live} outcome={view.lastOutcome} />
                </div>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        <Composer
          text={text}
          setText={setText}
          repo={dork.repo}
          provider={dork.provider ?? 'claude'}
          pending={pending}
          disabled={dork.archived}
          error={[error, stopError, archiveError, modelSwitch.error].find(Boolean) ?? ''}
          agentLabel={dork.codexModel?.model}
          picker={claudePicker(dork, settings?.claudeModels, (model, effort) => void modelSwitch.run(() => actions.chooseModel(dorkId, model ?? null, effort ?? null)))}
          upload={actions.uploadImage}
          reply={reply}
          onClearReply={() => setReply(undefined)}
          onSubmit={(images) =>
            run(async () => {
              const sent = text
              const quoted = reply
              // The optimistic row shows it at once; put the text and the reply back if the server refuses.
              setText('')
              setReply(undefined)
              try {
                await send(withReply(quoted, withImages(sent, images)))
              } catch (e) {
                setText(sent)
                setReply(quoted)
                throw e
              }
            })
          }
          onStop={working && !stopping && canReply ? () => void runStop(() => actions.interrupt(dorkId)) : undefined}
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
