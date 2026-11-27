import { CatchBoundary, createFileRoute, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { ImageCommentsProvider } from '../../../components/ImageComments'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopOptions } from '@dorks/client'
import { isDorkLocation, isDorkMode, type Block, type DorkLocation, type DorkMode } from '@dorks/shared'
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, MessageSquareIcon } from 'lucide-react'
import type { Settings } from '@dorks/client'
import { useBuilds, useDork, useDorkEvents, useDorks, useDorksClient, useGithubRepos, usePullRequest, useSettings, useSubscriptions, useWorkspaceRoots, useWorkspaceTree } from '@dorks/client/react'
import { ownersOf, useOwnerScope } from '../../../components/ownerScope'
import { ownerOf } from '../../../components/RepoAvatar'
import { ArchivedOwnerFilter } from '../../../components/ArchivedOwnerFilter'
import { List } from '../../../components/onboarding/List'
import { EmptyState } from '../../../components/EmptyState'
import { BrandCircle } from '../../../components/BrandCircle'
import { Alert, AlertDescription } from '@dorks/ui/alert'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroup, InputGroupButton } from '@dorks/ui/input-group'
import { resolveSharedImages } from '../../../components/ChatBlock'
import { CrewDetails } from '../../../components/CrewDetails'
import { AGENT_NAMES, SessionChat } from '../../../components/SessionChat'
import { ChatDetails } from '../../../components/ChatDetails'
import { ChatSplit, ShowDetailsButton, useDetailsOpen, useWide } from '../../../components/chat-details/layout'
import type { ChatDetailsData } from '../../../components/chat-details/types'
import type { WorkspaceSource } from '../../../components/chat-details/Files'
import type { PullRequestPanelData } from '../../../components/PullRequestPanel'
import { latestTasks, progressStore, progressTurns } from '../../../lib/progress'
import { useMarkRead } from '../../../lib/markRead'
import { environmentOf, type Environment, type EnvironmentBuild } from '../../../components/EnvironmentPicker'
import { withImages, Composer, claudeStartingEffort, CODEX_PREFERRED, preferredModel, type AgentProvider, type ModelPicker } from '../../../components/ChatComposer'
import { startingEffort } from '../../../lib/effort'
import { ChatMenu } from '../../../components/ChatMenu'
import { PresenceAvatars } from '../../../components/Teammates'
import { UsageMenu } from '../../../components/UsageMenu'
import { useMentions } from '../../../components/ComposerMenu'
import { ArchiveButton, PageHeader } from '../../../components/PageHeader'
import { SetupStatus } from '../../../components/SetupStatus'
import { canCreate, canCreateLocal } from '../../../lib/onboarding'
import { usePending } from '../../../lib/pending'
import { useDraft, useDraftSetter } from '../../../lib/draft'
import { useArchiveDork } from '../../../lib/archive'
import { THUMB_WIDTH } from '../../../lib/images'

// The selected dork lives in the `dork` search param (not local state) so the sidebar can highlight it and the URL is shareable.
export const Route = createFileRoute('/_conn/_app/dorks')({
  // `repo` preselects the new session's repository and `location` where it runs (the sidebar's + beside a repository group); `mode` its
  // mode (the Nerds group's +).
  validateSearch: (s: Record<string, unknown>): { dork?: string; repo?: string; location?: DorkLocation; mode?: DorkMode } => ({
    ...(typeof s.dork === 'string' ? { dork: s.dork } : {}),
    ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
    ...(isDorkLocation(s.location) ? { location: s.location } : {}),
    ...(isDorkMode(s.mode) ? { mode: s.mode } : {}),
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
  const { dork: selected, repo: presetRepo, location: presetLocation, mode: presetMode } = Route.useSearch()
  const navigate = Route.useNavigate()
  const setSelected = (id: string) => void navigate({ search: { dork: id } })
  const [showArchived, setShowArchived] = useState(false)
  const settings = useSettings()
  // First run happens here: the setup checklist under the composer (SetupStatus). The full-page /onboarding flow is kept but no
  // longer opened.
  const ready = !!settings && canCreate(settings)

  return (
    <div className="flex h-full min-h-0 flex-col" data-onboarding={settings ? (ready ? 'complete' : 'preparing') : 'loading'}>
      {!selected && <PageHeader title="New session" />}
      {settings && ready && claudeOnlyMissing(settings) && (
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
            {showArchived && <ArchivedSessions onOpen={setSelected} />}
            <div className={`${showArchived ? 'hidden' : 'flex'} mx-auto w-full max-w-[790px] flex-col gap-6`}>
              <h2 className="sr-only">What should we work on?</h2>
              <NewDork
                key={`${presetRepo}:${presetLocation}:${presetMode}`}
                initialRepo={presetRepo}
                initialLocation={presetLocation}
                initialMode={presetMode}
                onCreated={setSelected}
                disabled={!ready}
                localReady={!!settings && canCreateLocal(settings)}
                claudeReady={!!settings?.claudeToken}
                codexReady={!!settings?.boatEnvironment || !!settings?.codexAccount}
                antigravityReady={!!settings?.antigravityReady}
              />
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

/**
 * Show archived: the archived sessions, filtered by GitHub owner (remembered, ownerScope.ts) when they span more than one. The owners
 * are the archived sessions' own, then the GitHub login's.
 */
function ArchivedSessions({ onOpen }: { onOpen: (id: string) => void }) {
  const dorks = useDorks(true)
  const github = useGithubRepos()
  const owners = ownersOf(dorks?.flatMap((d) => (d.repo ? [d.repo] : [])) ?? [], github)
  const [scope, setScope] = useOwnerScope(owners)
  const archived = scope ? dorks?.filter((d) => d.repo && ownerOf(d.repo) === scope) : dorks
  return (
    <section aria-label="Archived sessions" className="mx-auto flex min-h-0 w-full max-w-[790px] flex-col gap-6 px-5">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-center text-lg font-medium">Archived sessions</h2>
        <ArchivedOwnerFilter owners={owners} scope={scope} setScope={setScope} />
      </div>
      {archived === undefined ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Loading sessions…
        </p>
      ) : archived.length === 0 ? (
        scope ? (
          <EmptyState figure="drawer" title={`No archived sessions from ${scope}`}>
            <Button size="sm" variant="outline" onClick={() => setScope('')}>
              Show all owners
            </Button>
          </EmptyState>
        ) : (
          <EmptyState figure="drawer" title="No archived sessions" description="Sessions you archive will show up here." />
        )
      ) : (
        <div className="overflow-y-auto">
          <List>
            {archived.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onOpen(d.id)} className="flex h-12 w-full items-center gap-3 px-4 text-left outline-none hover:bg-muted focus-visible:bg-muted">
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
  )
}

/** The repositories chats used, then everything the GitHub CLI login can see (the picker's own search narrows them). */
function useNewSessionRepos(dorks: { repo: string }[] | undefined): string[] {
  const github = useGithubRepos()
  const recent = [...new Set(dorks?.map((d) => d.repo).filter(Boolean) ?? [])].sort()
  return [...new Set([...recent, ...(github?.repos ?? [])])]
}

/**
 * Where a new session starts until the owner picks: the preset repository (the sidebar's +) in the build that holds it, else the default
 * build, else the first repository, in its build if one holds it.
 */
function initialEnvironment(builds: EnvironmentBuild[], repositories: string[], initialRepo: string | undefined, defaultBuildId: string | null | undefined): Environment {
  if (initialRepo) return environmentOf(builds, initialRepo)
  const preferred = builds.find((b) => b.id === defaultBuildId)
  if (preferred) return { buildId: preferred.id, repo: preferred.repos[0]! }
  return environmentOf(builds, repositories[0] ?? '')
}

/**
 * Whether the chosen agent can start (sending stays off until it can, like the server's `missingForSession`), and whether to say so
 * above the box: with no agent at all the setup checklist asks for the token, so only an owner who has Codex and picked Claude.
 */
/** Another agent is connected but Claude is not: the page suggests adding a Claude token. */
const claudeOnlyMissing = (s: Settings) => !s.claudeToken && (!!s.boatEnvironment || !!s.codexAccount)

const agentGate = (provider: AgentProvider, claudeReady: boolean, codexReady: boolean, antigravityReady: boolean) => {
  // OpenCode signs in with shared secrets (its provider keys): a missing one shows up in the thread.
  const missing = provider === 'claude' ? !claudeReady : provider === 'codex' ? !codexReady : provider === 'antigravity' ? !antigravityReady : false
  // Antigravity is never in the setup checklist on its own, so a missing sign-in is always said here.
  return { missing, notice: missing && ((provider === 'claude' && (codexReady || antigravityReady)) || provider === 'antigravity') }
}

type Choice = { model?: string; effort?: string; fast?: boolean }

/**
 * The new session's model menu: Claude's models (what its agent last reported), or Antigravity's (what `agy models` listed for the
 * signed-in plan, on the server). OpenCode's are known once its sandbox is up: it starts on its default and changes from the thread.
 * The model and effort it shows are exactly what the first message sends: every model starts at an effort (`startingEffort`), never
 * the agent's unnamed default.
 */
function newSessionPicker(provider: AgentProvider, settings: ReturnType<typeof useSettings>, choice: Choice, setChoice: (c: Choice) => void): ModelPicker | undefined {
  if (provider === 'claude') {
    const choices = settings?.claudeModels ?? []
    const model = choice.model ?? preferredModel(choices)
    const efforts = choices.find((c) => c.model === (model ?? 'default'))?.efforts ?? []
    const effort = choice.effort && efforts.includes(choice.effort as never) ? choice.effort : claudeStartingEffort(choices, model)
    return { choices, ...choice, model, effort, onChange: (model, effort, fast) => setChoice({ model, effort, fast }) }
  }
  // Antigravity's list may not be known yet; a model from the menu's short list is chosen all the same (agy checks it at start).
  if (provider === 'antigravity') return { choices: settings?.antigravityModels ?? [], model: choice.model, onChange: (model) => setChoice({ model }) }
  // Codex lists its models once a session has run (the plan's list is then remembered); before that the menu's short list names them.
  // With none picked, the short list's first.
  if (provider === 'codex') {
    const choices = settings?.codexModels ?? []
    const model = choice.model ?? CODEX_PREFERRED
    const listed = choices.find((c) => c.model === model)?.efforts
    const efforts: string[] = listed?.length ? [...listed] : ['low', 'medium', 'high', 'xhigh']
    return { choices, model, effort: choice.effort ?? startingEffort('codex', model, efforts), onChange: (model, effort) => setChoice({ model, effort }) }
  }
  return undefined
}

/** What the first message sends for the model: the picker's own values, so it never differs from what the menu showed. */
function startChoice(provider: AgentProvider, picker: ModelPicker | undefined): Choice {
  if (!picker) return {}
  if (provider === 'claude') return { model: picker.model, effort: picker.effort, fast: picker.fast }
  if (provider === 'codex') return picker.model ? { model: picker.model, effort: picker.effort } : {}
  if (provider === 'antigravity') return picker.model ? { model: picker.model } : {}
  return {}
}

/** The agent a new session starts on: Claude when it is connected, else the one that is. */
const firstReady = (claude: boolean, codex: boolean, antigravity: boolean): AgentProvider => (claude ? 'claude' : codex ? 'codex' : antigravity ? 'antigravity' : 'claude')

/** Above the box: how to connect the agent picked, when another one is connected (with none, the setup checklist asks). */
function AgentNotice({ provider }: { provider: AgentProvider }) {
  return (
    <p className="mx-5 mb-2 text-sm text-destructive" role="status">
      {provider === 'antigravity' ? (
        <>
          <Link to="/settings/$page" params={{ page: 'agents' }} className="font-medium underline underline-offset-4">
            Sign in with Google in settings
          </Link>{' '}
          to use Antigravity.
        </>
      ) : (
        <>
          Add a{' '}
          <Link to="/settings" className="font-medium underline underline-offset-4">
            Claude token in settings
          </Link>{' '}
          to use Claude Code.
        </>
      )}
    </p>
  )
}

function NewDork({
  initialRepo,
  initialLocation,
  initialMode,
  onCreated,
  disabled,
  localReady,
  claudeReady,
  codexReady,
  antigravityReady,
}: {
  initialRepo?: string
  /** Where the session runs, preset by a repository group's + (a local group starts a local session); else the owner's default. */
  initialLocation?: DorkLocation
  initialMode?: DorkMode
  onCreated: (id: string) => void
  /** A cloud session cannot start yet (Boat, its snapshot or GitHub is missing). */
  disabled: boolean
  /** A local session can start: this client may run one on the server's computer, and GitHub is connected. */
  localReady: boolean
  claudeReady: boolean
  codexReady: boolean
  antigravityReady: boolean
}) {
  // Each visit to the page (New session in the sidebar, even when already here) puts the cursor in the box.
  const visit = useRouterState({ select: (s) => s.location.state.__TSR_key ?? s.location.href })
  const { actions } = useDorksClient()
  const settings = useSettings()
  // Sent with the first message (the server checks it against the models the agent reported), then kept by the session.
  const [choice, setChoice] = useState<{ model?: string; effort?: string; fast?: boolean }>({})
  const dorks = useDorks()
  const builds = useBuilds()
  // A session starts in a repository, so only built builds that hold one are offered.
  const built: EnvironmentBuild[] = (builds ?? []).filter((b) => b.image && b.repos.length > 0).map((b) => ({ id: b.id, name: b.name, repos: b.repos.map((r) => r.repo) }))
  const repositories = useNewSessionRepos(dorks)
  const [picked, setPicked] = useState<Environment | undefined>(undefined)
  // A picked build that is gone (deleted, or its image removed) falls back like an unpicked one.
  const env = picked && (picked.buildId === null || built.some((b) => b.id === picked.buildId)) ? picked : initialEnvironment(built, repositories, initialRepo, settings?.defaultBuildId)
  const { buildId, repo } = env
  const location = useNewSessionLocation(initialLocation)
  const local = location?.value === 'local'
  const [message, setMessage] = useDraft('new')
  const [provider, pickProvider] = useState<AgentProvider>(() => firstReady(claudeReady, codexReady, antigravityReady))
  // A model belongs to its agent: switching agents starts the new one on its default, or on the model picked with it.
  const setProvider = (p: AgentProvider, next?: Choice) => {
    if (p !== provider || next) setChoice(next ?? {})
    pickProvider(p)
  }
  const { run, pending, error } = usePending()
  const agent = agentGate(provider, claudeReady, codexReady, antigravityReady)
  const mode = newSessionMode(initialRepo, initialMode)
  // Only a code session starts in its repository, so only its `@` menu has files to offer.
  const mentions = useMentions(provider, { repo: mode === 'code' ? repo || undefined : undefined })
  const picker = newSessionPicker(provider, settings, choice, setChoice)
  return (
    <div className="[&>div]:max-w-none">
      {agent.notice && <AgentNotice provider={provider} />}
      <Composer
        text={message}
        setText={setMessage}
        // Builds are cloud machines (docs/builds.md): a local session picks only its repository.
        environment={{ builds: local ? [] : built, repositories, value: local ? { buildId: null, repo } : env, onChange: setPicked }}
        location={location}
        mode={{ value: mode }}
        provider={provider}
        setProvider={setProvider}
        codexEnabled={codexReady}
        pending={pending}
        disabled={(local ? !localReady : disabled) || agent.missing}
        error={error}
        picker={picker}
        catalog={{ claude: settings?.claudeModels, antigravity: settings?.antigravityModels, codex: settings?.codexModels }}
        upload={actions.uploadImage}
        draftKey="new"
        usage={<UsageMenu provider={provider} />}
        mentions={mentions}
        focusKey={visit}
        typeToFocus
        onSubmit={(images) =>
          run(async () => {
            onCreated(
              (
                await actions.createDork({
                  mode,
                  // Only a code session works in a repository; the others start on the chosen build's machine with none.
                  // A chat or a nerd has no repository, so the repository chooser's build does not apply: it starts on the owner's default
                  // build (the server's fallback when buildId is omitted, a build without repositories included).
                  ...(mode === 'code' ? { repo: repo.trim(), buildId: local ? null : buildId } : {}),
                  ...(local ? { location: 'local' as const } : {}),
                  message: withImages(message, images),
                  provider,
                  ...startChoice(provider, picker),
                })
              ).id,
            )
            setMessage('')
          })
        }
      />
    </div>
  )
}

/**
 * The new session's Cloud / Local choice (docs/local-dorks.md), only when this client may start local sessions: the owner's remembered
 * default (or the location a repository group's + preset) until they pick, and a pick becomes the new default.
 */
function useNewSessionLocation(preset?: DorkLocation) {
  const settings = useSettings()
  const { actions } = useDorksClient()
  const [picked, setPicked] = useState<DorkLocation>()
  if (!settings?.local?.available) return undefined
  return {
    value: picked ?? preset ?? settings.defaultLocation ?? 'cloud',
    onChange: (l: DorkLocation) => {
      setPicked(l)
      void actions.updateSettings({ defaultLocation: l }).catch(() => {})
    },
  }
}

/** The new session's mode (docs/modes.md), with no menu of its own: a nerd from the Nerds group's +, else a code session. */
function newSessionMode(initialRepo: string | undefined, preset: DorkMode | undefined): DorkMode {
  return !initialRepo && preset ? preset : 'code'
}

type DorkView = NonNullable<ReturnType<typeof useDork>>
type DorksActions = ReturnType<typeof useDorksClient>['actions']

/** Chat details for a session: the agent's work, its pull request, screenshots (newest first), previews and computer. */
function detailsData(
  dork: DorkView,
  work: Pick<ChatDetailsData, 'progress' | 'tasks'>,
  actions: DorksActions,
  computer: Pick<NonNullable<ChatDetailsData['computer']>, 'used' | 'fetchUrl' | 'interrupt'>,
): ChatDetailsData {
  return {
    ...work,
    pr: prOf(dork.prUrl, dork.prState),
    artifacts: dork.images
      ?.map((i, n) => ({
        id: i.id,
        imageId: i.id,
        name: i.caption ?? `Screenshot ${n + 1}`,
        type: 'Screenshot',
        src: actions.imageUrl(i.id),
        thumb: actions.imageUrl(i.id, THUMB_WIDTH),
        width: i.width,
        height: i.height,
      }))
      .reverse(),
    previews: dork.previews?.map((p) => ({ name: p.title ?? `Port ${p.port}`, url: p.url, port: p.port })),
    computer: { awake: dork.state === 'working' || dork.state === 'idle', working: dork.state === 'working', ...computer },
    local: dork.location === 'local',
  }
}

/** The session's pull request, read live from GitHub, and the merge and branch update Chat details offers on it. */
function usePullRequestPanel(dorkId: string, dork: { prUrl?: string } | null | undefined): PullRequestPanelData | undefined {
  const { actions } = useDorksClient()
  const prUrl = dork?.prUrl
  // Read by URL, so a read cached for the session's previous PR never shows as its new one.
  const pr = usePullRequest(dorkId, prUrl)
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
    merge: async (method, sha) => void (await actions.mergePullRequest(dorkId, method, sha, prUrl)),
    updateBranch: (sha) => actions.updatePullRequestBranch(dorkId, sha, prUrl),
    markReady: () => actions.markPullRequestReady(dorkId, prUrl),
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
    markReady: () => actions.markPullRequestReady(dorkId, url),
  }
}

/** The Files tab's reads and saves for this session, through the client (the server asks the sandbox's bridge). */
function useWorkspace(dorkId: string): WorkspaceSource {
  const { actions } = useDorksClient()
  return useMemo(
    () => ({
      useRoots: () => useWorkspaceRoots(dorkId),
      useTree: (root: string) => useWorkspaceTree(dorkId, root),
      read: (root: string, path: string) => actions.readWorkspaceFile(dorkId, root, path),
      write: (root: string, path: string, contents: string, sha?: string) => actions.writeWorkspaceFile(dorkId, root, path, contents, sha),
      refresh: () => actions.refreshWorkspace(dorkId),
    }),
    [actions, dorkId],
  )
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
  const setText = useDraftSetter(dorkId)
  // Each chat's Progress starts on its newest step.
  useEffect(() => progressStore.reset(), [dorkId])
  useMarkRead(dorkId, dork?.unread)
  // Walks of the whole transcript: once per change of it, not on every render (a keystroke in the composer, a clock tick).
  const computerUsed = useMemo(() => view.blocks.some((b) => b.kind === 'tool' && b.name.startsWith('mcp__computer__')), [view.blocks])
  const showsWork = detailsOpen && dork?.mode !== 'nerd' // a dork's details are its crew, not Progress
  const work = useMemo(
    // Shared screenshots resolve to their URLs here as they do in the thread, so a progress message still shows its images.
    () => (showsWork ? { progress: progressTurns(resolveSharedImages(view.blocks, actions.imageUrl).blocks), tasks: latestTasks(view.blocks) } : undefined),
    [showsWork, view.blocks, actions],
  )
  const fetchDesktopUrl = useCallback((opts: DesktopOptions) => actions.desktopUrl(dorkId, opts), [actions, dorkId])
  const interruptAgent = useCallback(() => actions.interrupt(dorkId), [actions, dorkId])
  const pullRequest = usePullRequestPanel(dorkId, dork)
  const subscriptions = useSubscriptions(dorkId)
  const usePr = useCallback((url: string) => useSessionPullRequest(dorkId, url), [dorkId])
  const workspace = useWorkspace(dorkId)
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
  const crew = dork.mode === 'nerd'
  const previewSession = { id: dorkId, agent: AGENT_NAMES[dork.provider], provider: dork.provider }
  const details = !detailsOpen ? undefined : crew ? (
    <CrewDetails dork={dork} onClose={() => setDetailsOpen(false)} onAsk={setText} />
  ) : (
    <ChatDetails
      sessionId={dorkId}
      data={{ ...detailsData(dork, work!, actions, { used: computerUsed, fetchUrl: fetchDesktopUrl, interrupt: interruptAgent }), pullRequest, subscriptions, usePullRequest: usePr, workspace }}
      onClose={() => setDetailsOpen(false)}
      onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)}
      previewSession={previewSession}
      onAsk={setText}
    />
  )
  return (
    <ImageCommentsProvider session={previewSession}>
      <ChatSplit details={details}>
        <section className="flex min-w-0 flex-1 flex-col" aria-label="thread" data-state={dork.state} data-mode={dork.mode ?? 'code'}>
          <PageHeader
            parent={dork.parentId ? <ParentCrumb id={dork.parentId} /> : undefined}
            title={crew && dork.icon ? `${dork.icon} ${dork.title}` : dork.title}
            titleActions={<ArchiveButton archived={dork.archived} disabled={archiving} onClick={() => void runArchive(() => archiveDork(dorkId, !dork.archived))} />}
            actions={
              <>
                <PresenceAvatars dorkId={dorkId} />
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
    </ImageCommentsProvider>
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
