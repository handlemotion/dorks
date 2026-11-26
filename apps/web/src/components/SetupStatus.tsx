import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckIcon, LoaderCircleIcon } from 'lucide-react'
import { useDorksClient, useSnapshot } from '@dorks/client/react'
import type { BoatSignIn, Settings, SnapshotStatus } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { openExternal } from '../lib/desktop'
import { connectGithub, useCloudGithub, type CloudGithub } from '../lib/githubApp'
import { stepDone } from '../lib/onboarding'
import { usePending } from '../lib/pending'
import { SecretInput } from './onboarding/Frame'
import { StepProgress } from './StepProgress'
import { AntigravitySignIn } from './AntigravitySignIn'

type StepState = 'done' | 'running' | 'todo' | 'failed'

interface Step {
  id: string
  title: string
  state: StepState
  /** A short muted line under the title: what is happening, or what went wrong. */
  detail?: string
  /** On the right: a small button or a step count. */
  trailing?: ReactNode
  /** Under the title: what the owner fills in right here (the Claude token). */
  body?: ReactNode
}

/**
 * "Set up Dorks", under the new-session composer: the whole first run. Every step between the owner and a working session,
 * checked off as it lands, with the Boat snapshot build shown in its row. Boat and GitHub connect by themselves when their CLIs
 * are signed in (the server does it); otherwise each row has the one thing to do, right here. It also appears, with everything else checked, while a newer app
 * rebuilds an existing snapshot. Renders nothing once every step is done and no build is running.
 */
export function SetupStatus({ settings }: { settings: Settings }) {
  const snap = useSnapshot()
  const steps = useSteps(settings, snap)
  if (!steps) return null
  const done = steps.filter((s) => s.state === 'done').length

  return (
    <section aria-label="Set up Dorks" data-testid="setup-checklist" className="flex flex-col gap-2 text-sm">
      <header className="flex h-7 items-center gap-3 px-3">
        <h3 className="flex-1">Set up Dorks</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {done} of {steps.length}
        </span>
        <div className="w-15">
          <StepProgress step={done} of={steps.length} label="Setup progress" tone="brand" />
        </div>
      </header>
      <ol className="flex flex-col rounded-(--control-radius) border border-border py-1">
        {steps.map((step) => (
          <li key={step.id} data-state={step.state} className="flex min-h-9 items-center gap-2 px-3 py-1.5">
            <StepMark state={step.state} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={step.state === 'done' ? 'text-muted-foreground' : undefined}>{step.title}</span>
              {step.detail && <span className={`text-xs ${step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{withCode(step.detail)}</span>}
              {step.body}
            </div>
            {step.trailing}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Shows `backticked` commands (in the server's messages too) as code. */
const withCode = (text: string) =>
  text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  )

function StepMark({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span aria-label="Done" className="grid size-3.5 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
        <CheckIcon className="size-2" strokeWidth={3.5} />
      </span>
    )
  if (state === 'running') return <LoaderCircleIcon aria-label="In progress" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
  return <span aria-label={state === 'failed' ? 'Failed' : 'To do'} className={`size-3.5 shrink-0 rounded-full border ${state === 'failed' ? 'border-destructive' : 'border-input bg-muted'}`} />
}

const SettingsLink = ({ page, children }: { page: string; children: ReactNode }) => (
  <Button size="sm" variant="outline" render={<Link to="/settings/$page" params={{ page }} />} nativeButton={false}>
    {children}
  </Button>
)

/** The steps, or null when there is nothing to show. */
function useSteps(settings: Settings, snap: SnapshotStatus | undefined): Step[] | null {
  const { actions } = useDorksClient()
  const build = usePending()
  const cloudGithub = useCloudGithub()
  const d = stepDone(settings)
  const snapBusy = snap?.state === 'building' || snap?.state === 'failed'
  if (d.boat && d.agents && d.github && d.snapshot && !snapBusy) return null

  const buildButton = (label: string) => (
    <Button size="sm" variant="outline" disabled={build.pending || !snap?.canBuild} onClick={() => void build.run(async () => void (await actions.buildSnapshot()))}>
      {build.pending ? 'Starting…' : label}
    </Button>
  )
  const snapshot = snapshotStep(snap, d.boat, d.snapshot, buildButton)
  if (build.error) snapshot.detail = build.error

  const steps: Step[] = [
    d.boat ? { id: 'boat', title: 'Connect Boat', state: 'done' } : boatStep(settings.boatSignIn),
    d.agents ? { id: 'agents', title: 'Connect an agent', state: 'done' } : { id: 'agents', title: 'Connect an agent', state: 'todo', body: <AgentForms settings={settings} /> },
    d.github ? { id: 'github', title: 'Connect GitHub', state: 'done' } : cloudGithub ? cloudGithubStep(cloudGithub) : githubStep(settings),
    snapshot,
  ]
  return steps
}

/**
 * Boat, from the server's sign-in with the Boat CLI (services/boatSignIn.ts). With the CLI signed in it connects by itself; signed
 * out, Sign in opens Boat's browser sign-in and the row waits for it. Without the CLI (or an older server), a key in Settings.
 */
function boatStep(signIn: BoatSignIn | null | undefined): Step {
  const step = { id: 'boat', title: 'Connect Boat' }
  switch (signIn?.state) {
    case 'checking':
      return { ...step, state: 'running', detail: 'Looking for your Boat login…' }
    case 'connecting':
      return { ...step, state: 'running', detail: 'Connecting your Boat account…' }
    case 'signing_in':
      return {
        ...step,
        state: 'running',
        detail: `Finish signing in in your browser${signIn.userCode ? `. If it asks for a code, enter ${signIn.userCode}` : ''}.`,
        trailing: signIn.url ? <OpenLink url={signIn.url} /> : undefined,
      }
    case 'signed_out':
      return { ...step, state: 'todo', detail: 'Sign in with GitHub in your browser.', trailing: <BoatSignInButton label="Sign in" /> }
    case 'failed':
      return { ...step, state: 'failed', detail: signIn.error, trailing: <BoatSignInButton label="Try again" /> }
    default:
      return { ...step, state: 'todo', detail: 'Install the Boat CLI, or add a Boat API key.', trailing: <SettingsLink page="boat">Add key</SettingsLink> }
  }
}

function BoatSignInButton({ label }: { label: string }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          void run(async () => {
            const state = await actions.signInBoat()
            if (state?.state === 'signing_in' && state.url) openExternal(state.url)
          })
        }
      >
        {pending ? 'Opening…' : label}
      </Button>
    </div>
  )
}

/** The browser sign-in again, for a tab that was closed or never opened. */
const OpenLink = ({ url }: { url: string }) => (
  <Button size="sm" variant="outline" onClick={() => openExternal(url)}>
    Open again
  </Button>
)

/** GitHub connects by itself with the GitHub CLI's login; the row says what to run when it cannot, and checks again. */
function githubStep(settings: Settings): Step {
  const problem = settings.github.problem
  return { id: 'github', title: 'Connect GitHub', state: 'todo', detail: problem ?? 'Uses the GitHub CLI’s login: run `gh auth login` in a terminal.', trailing: <GithubCheckButton /> }
}

/**
 * A cloud org's GitHub is the Dorks Agents app: an owner or admin installs it from here (GitHub's round trip comes back to the app,
 * which reads the connection again); a member asks one of them.
 */
function cloudGithubStep(github: CloudGithub): Step {
  const step = { id: 'github', title: 'Connect GitHub', state: 'todo' as const }
  if (github.connection && !github.connection.configured) return { ...step, detail: 'This Dorks Cloud server has no GitHub app yet.' }
  if (!github.admin) return { ...step, detail: 'Ask an owner or admin of this organization to connect GitHub.' }
  return { ...step, detail: 'Install Dorks Agents on GitHub and pick the repositories sessions work in.', trailing: <CloudGithubButton /> }
}

function CloudGithubButton() {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && (
        <span className="max-w-60 truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => connectGithub(actions, 'new'))}>
        {pending ? 'Opening…' : 'Connect'}
      </Button>
    </div>
  )
}

function GithubCheckButton() {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && (
        <span className="max-w-60 truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.updateSettings({ githubConnected: true }))}>
        {pending ? 'Checking…' : 'Connect'}
      </Button>
    </div>
  )
}

/** Claude's token, or Antigravity's one-button Google sign-in: either one is enough to start. */
function AgentForms({ settings }: { settings: Settings }) {
  return (
    <div className="flex flex-col gap-3">
      <ClaudeTokenForm />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Or use your Google AI plan with Antigravity.</span>
        <AntigravitySignIn settings={settings} />
      </div>
    </div>
  )
}

/** `claude setup-token` prints a token that only a terminal shows, so this is the one step that takes a paste. */
function ClaudeTokenForm() {
  const { actions } = useDorksClient()
  const [token, setToken] = useState('')
  const { run, pending, error } = usePending()
  return (
    <form
      className="mt-1.5 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (token.trim()) void run(() => actions.updateSettings({ claudeToken: token.trim() }))
      }}
    >
      <span className="text-xs text-muted-foreground">
        Run <code className="font-mono">claude setup-token</code> in a terminal, then paste the token it prints. Or use{' '}
        <Link to="/settings/$page" params={{ page: 'agents' }} className="underline underline-offset-4">
          Codex
        </Link>
        .
      </span>
      <div className="flex items-center gap-2">
        <SecretInput aria-label="Claude token" className="h-8" autoComplete="off" placeholder="sk-ant-oat01-…" value={token} onChange={(e) => setToken(e.target.value)} />
        <Button size="sm" variant="outline" type="submit" disabled={pending || !token.trim()}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  )
}

/** Boat's base snapshot: built in the background once the key is saved, and again when a newer app needs a newer one. */
function snapshotStep(snap: SnapshotStatus | undefined, boat: boolean, have: boolean, buildButton: (label: string) => ReactNode): Step {
  if (snap?.state === 'building') {
    return {
      id: 'snapshot',
      title: have ? 'Updating Boat' : 'Preparing Boat',
      state: 'running',
      trailing: (
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {snap.message ?? 'Starting'} · {snap.stepIndex + 1} of {snap.stepCount}
        </span>
      ),
    }
  }
  if (snap?.state === 'failed') {
    const error = snap.error ?? 'The build failed'
    return {
      id: 'snapshot',
      title: have ? 'Updating Boat failed' : 'Preparing Boat failed',
      state: 'failed',
      detail: `${error}${/[.!?]$/.test(error) ? '' : '.'}${have ? ' Sessions keep using the previous one.' : ''}`,
      trailing: buildButton('Retry'),
    }
  }
  if (have) return { id: 'snapshot', title: 'Prepare Boat', state: 'done' }
  if (!boat) return { id: 'snapshot', title: 'Prepare Boat', state: 'todo', detail: 'Starts once Boat is connected.' }
  return { id: 'snapshot', title: 'Prepare Boat', state: 'todo', detail: snap?.cannotBuildReason ?? 'A few minutes, in the background.', trailing: buildButton('Prepare Boat') }
}
