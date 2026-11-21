import { CatchBoundary, createFileRoute, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import type { DesktopOptions } from '@dorks/client'
import type { Block } from '@dorks/shared'
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, MessageSquareIcon } from 'lucide-react'
import { useBuilds, useDork, useDorkEvents, useDorks, useDorksClient, useGithubRepos, usePullRequest, useSettings, useSubscriptions } from '@dorks/client/react'
import { ownersOf, useOwnerScope } from '../../../components/ownerScope'
import { ownerOf } from '../../../components/RepoAvatar'
import { List } from '../../../components/onboarding/List'
import { EmptyState } from '../../../components/EmptyState'
import { BrandCircle } from '../../../components/BrandCircle'
import { Alert, AlertDescription } from '@dorks/ui/alert'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupButton } from '@dorks/ui/input-group'
import { resolveSharedImages } from '../../../components/ChatBlock'
import { CrewDetails } from '../../../components/CrewDetails'
import { SessionChat } from '../../../components/SessionChat'
import { ChatDetails } from '../../../components/ChatDetails'
import { ChatSplit, ShowDetailsButton, useDetailsOpen, useWide } from '../../../components/chat-details/layout'
import type { ChatDetailsData } from '../../../components/chat-details/types'
import type { PullRequestPanelData } from '../../../components/PullRequestPanel'
import { latestTasks, progressStore, progressTurns } from '../../../lib/progress'
import { withImages, Composer, preferredModel, type AgentProvider } from '../../../components/ChatComposer'
import { ChatMenu } from '../../../components/ChatMenu'
import { ArchiveButton, PageHeader } from '../../../components/PageHeader'
import { SetupStatus } from '../../../components/SetupStatus'
import { canCreate } from '../../../lib/onboarding'
import { usePending } from '../../../lib/pending'
import { useDraft } from '../../../lib/draft'
import { useArchiveDork } from '../../../lib/archive'

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
  // First run happens here: the setup checklist under the composer (SetupStatus). The full-page /onboarding flow is kept but no
  // longer opened.
  const ready = !!settings && canCreate(settings)

  return (
    <div className="flex h-full min-h-0 flex-col" data-onboarding={settings ? (ready ? 'complete' : 'preparing') : 'loading'}>
      {!selected && <PageHeader title="New session" />}
      {settings && ready && !settings.claudeToken && !!settings.boatEnvironment && (
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
              <NewDork key={presetRepo} initialRepo={presetRepo} onCreated={setSelected} disabled={!ready} claudeReady={!!settings?.claudeToken} codexReady={!!settings?.boatEnvironment} />
              {settings && (
                <div className="mt-6 px-5 empty:hidden">
                  <SetupStatus settings={settings} />
                </div>
              )}
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

/** The build's repositories, then the ones chats used, then everything the GitHub CLI login can see; only the owner in scope's. */
function useNewSessionRepos(buildRepos: string[], dorks: { repo: string }[] | undefined): string[] {
  const github = useGithubRepos()
  const recent = [...new Set(dorks?.map((d) => d.repo).filter(Boolean) ?? [])].sort()
  const [scope] = useOwnerScope(ownersOf(recent, github))
  return [...new Set([...buildRepos, ...recent, ...(github?.repos ?? [])])].filter((r) => !scope || ownerOf(r) === scope)
}

/**
 * Whether the chosen agent can start (sending stays off until it can, like the server's `missingForSession`), and whether to say so
 * above the box: with no agent at all the setup checklist asks for the token, so only an owner who has Codex and picked Claude.
 */
const agentGate = (provider: AgentProvider, claudeReady: boolean, codexReady: boolean) => {
  const missing = provider === 'claude' ? !claudeReady : !codexReady
  return { missing, notice: missing && provider === 'claude' && codexReady }
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
  // Each visit to the page (New session in the sidebar, even when already here) puts the cursor in the box.
  const visit = useRouterState({ select: (s) => s.location.state.__TSR_key ?? s.location.href })
  const { actions } = useDorksClient()
  const settings = useSettings()
  // Sent with the first message (the server checks it against the models the agent reported), then kept by the session.
  const [choice, setChoice] = useState<{ model?: string; effort?: string; fast?: boolean }>({})
  const dorks = useDorks()
  const builds = useBuilds()
  const built = (builds ?? []).filter((b) => b.image).map((b) => ({ id: b.id, name: b.name, repos: b.repos.map((r) => r.repo) }))
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  // Until the owner picks one: the default build when it is built, else the base machine.
  const buildId = picked !== undefined ? picked : built.some((b) => b.id === settings?.defaultBuildId) ? (settings?.defaultBuildId ?? null) : null
  const buildRepos = built.find((b) => b.id === buildId)?.repos ?? []
  const repositories = useNewSessionRepos(buildRepos, dorks)
  const [chosen, setRepo] = useState(initialRepo)
  const repo = chosen ?? repositories[0] ?? ''
  const [message, setMessage] = useDraft('new')
  const [provider, setProvider] = useState<AgentProvider>(claudeReady ? 'claude' : codexReady ? 'codex' : 'claude')
  const { run, pending, error } = usePending()
  const agent = agentGate(provider, claudeReady, codexReady)
  return (
    <div className="[&>div]:max-w-none">
      {agent.notice && (
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
        disabled={disabled || agent.missing}
        error={error}
        picker={{
          choices: settings?.claudeModels ?? [],
          ...choice,
          model: choice.model ?? preferredModel(settings?.claudeModels ?? []),
          onChange: (model, effort, fast) => setChoice({ model, effort, fast }),
        }}
        upload={actions.uploadImage}
        machine={{ builds: built, buildId, onChange: setPicked }}
        focusKey={visit}
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

/** Chat details for a session: the agent's work, its pull request, screenshots (newest first), previews and computer. */
function detailsData(dork: DorkView, blocks: Block[], actions: DorksActions, computer: Pick<NonNullable<ChatDetailsData['computer']>, 'used' | 'fetchUrl' | 'interrupt'>): ChatDetailsData {
  return {
    // Shared screenshots resolve to their URLs here as they do in the thread, so a progress message still shows its images.
    progress: progressTurns(resolveSharedImages(blocks, actions.imageUrl).blocks),
    tasks: latestTasks(blocks),
    pr: prOf(dork.prUrl, dork.prState),
    artifacts: dork.images?.map((i, n) => ({ id: i.id, name: i.caption ?? `Screenshot ${n + 1}`, type: 'Screenshot', src: actions.imageUrl(i.id), width: i.width, height: i.height })).reverse(),
    previews: dork.previews?.map((p) => ({ name: p.title ?? `Port ${p.port}`, url: p.url, port: p.port })),
    computer: { awake: dork.state === 'working' || dork.state === 'idle', working: dork.state === 'working', ...computer },
  }
}

/** The session's pull request, read live from GitHub, and the merge and branch update Chat details offers on it. */
function usePullRequestPanel(dorkId: string, dork: { prUrl?: string } | null | undefined): PullRequestPanelData | undefined {
  const { actions } = useDorksClient()
  const prUrl = dork?.prUrl
  const pr = usePullRequest(dorkId)
  // The agent just opened (or moved to) a pull request: read it now rather than at the next poller change.
  useEffect(() => {
    if (prUrl) actions.refreshPullRequest(dorkId)
  }, [actions, dorkId, prUrl])
  const refresh = useCallback(() => actions.refreshPullRequest(dorkId), [actions, dorkId])
  if (!prUrl) return undefined
  return {
    view: pr.data,
    error: pr.error?.message,
    refresh,
    merge: async (method, sha) => void (await actions.mergePullRequest(dorkId, method, sha)),
    updateBranch: (sha) => actions.updatePullRequestBranch(dorkId, sha),
  }
}

/** Another of the session's pull requests (by url), read live from GitHub, with its own merge and branch update. */
function useSessionPullRequest(dorkId: string, url: string): PullRequestPanelData {
  const { actions } = useDorksClient()
  const pr = usePullRequest(dorkId, url)
  const refresh = useCallback(() => actions.refreshPullRequest(dorkId), [actions, dorkId])
  return {
    view: pr.data,
    error: pr.error?.message,
    refresh,
    merge: async (method, sha) => void (await actions.mergePullRequest(dorkId, method, sha, url)),
    updateBranch: (sha) => actions.updatePullRequestBranch(dorkId, sha, url),
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
  const { view, loading } = useDorkEvents(dorkId)
  const { run: runArchive, pending: archiving, error: archiveError } = usePending()
  const archiveDork = useArchiveDork()
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()
  const wide = useWide()
  // One draft for the composer and everything on the page that writes into it (Ask for…, picked elements).
  const draft = useDraft(dorkId)
  const setText = draft[1]
  // Each chat's Progress starts on its newest step.
  useEffect(() => progressStore.reset(), [dorkId])
  const computerUsed = view.blocks.some((b) => b.kind === 'tool' && b.name.startsWith('mcp__computer__'))
  const fetchDesktopUrl = useCallback((opts: DesktopOptions) => actions.desktopUrl(dorkId, opts), [actions, dorkId])
  const interruptAgent = useCallback(() => actions.interrupt(dorkId), [actions, dorkId])
  const pullRequest = usePullRequestPanel(dorkId, dork)
  const subscriptions = useSubscriptions(dorkId)
  const usePr = useCallback((url: string) => useSessionPullRequest(dorkId, url), [dorkId])
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
  const crew = dork.kind === 'coordinator'
  const details = !detailsOpen ? undefined : crew ? (
    <CrewDetails dork={dork} onClose={() => setDetailsOpen(false)} onAsk={setText} />
  ) : (
    <ChatDetails
      sessionId={dorkId}
      data={{ ...detailsData(dork, view.blocks, actions, { used: computerUsed, fetchUrl: fetchDesktopUrl, interrupt: interruptAgent }), pullRequest, subscriptions, usePullRequest: usePr }}
      onClose={() => setDetailsOpen(false)}
      onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)}
      onAsk={setText}
    />
  )
  return (
    <ChatSplit details={details}>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="thread" data-state={dork.state} data-kind={dork.kind ?? 'agent'}>
        <PageHeader
          parent={dork.parentId ? <ParentCrumb id={dork.parentId} /> : undefined}
          title={crew && dork.icon ? `${dork.icon} ${dork.title}` : dork.title}
          titleActions={<ArchiveButton archived={dork.archived} disabled={archiving} onClick={() => void runArchive(() => archiveDork(dorkId, !dork.archived))} />}
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
        <SessionChat
          dork={dork}
          error={archiveError}
          draft={draft}
          // Progress lives in Chat details, which narrow windows and dorks (their details are Sessions) do not show.
          onOpenSteps={
            wide && !crew
              ? (keys) => {
                  progressStore.show(keys)
                  setDetailsOpen(true)
                }
              : undefined
          }
        />
      </section>
    </ChatSplit>
  )
}

/** A worker open full screen: its dork, one click away in the header (docs/crew.md). */
function ParentCrumb({ id }: { id: string }) {
  const parent = useDork(id)
  return (
    <Link to="/dorks" search={{ dork: id }} className="flex min-w-0 items-center gap-1.5 hover:text-foreground" aria-label={`Back to ${parent?.title ?? 'the dork'}`}>
      {parent?.icon && <span aria-hidden>{parent.icon}</span>}
      <span className="max-w-48 truncate">{parent?.title ?? 'Dork'}</span>
    </Link>
  )
}

/** The pull request from the stored url (the number is read from it, since the backend does not keep it separately) and its state. */
function prOf(url: string | undefined, state: DorkView['prState']) {
  if (!url) return undefined
  const n = /\/pull\/(\d+)/.exec(url)?.[1]
  return { url, number: n ? Number(n) : undefined, state }
}
