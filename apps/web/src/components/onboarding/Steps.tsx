import { useState } from 'react'
import { useDorksClient, useSnapshot } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { Progress } from '@dorks/ui/progress'
import { saveBoat } from '../../lib/boat'
import { isDesktop, readGhToken, setPublicUrl } from '../../lib/desktop'
import { canCreate, TUNNEL_SKIPPED_KEY, WELCOMED_KEY } from '../../lib/onboarding'
import { usePending } from '../../lib/pending'
import { A, ErrorText, Field, Heading, Primary, StepForm } from './Frame'

interface StepProps {
  settings: Settings
  onNext: () => void
}

export function Welcome({ onNext }: StepProps) {
  return (
    <>
      <Heading title="Welcome to Dorks">Run coding agents in your own Boat sandboxes and follow their work from one place on your Mac. Nothing is hosted for you.</Heading>
      <Primary
        onClick={() => {
          localStorage.setItem(WELCOMED_KEY, '1')
          onNext()
        }}
      >
        Get started
      </Primary>
    </>
  )
}

export function BoatKey({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const [key, setKey] = useState('')
  const [org, setOrg] = useState(settings.boatOrg ?? '')
  const { run, pending, error } = usePending()
  return (
    <>
      <Heading title="Connect Boat">Dorks creates sandboxes in your own Boat account. The key is stored encrypted on this Mac and never shown again.</Heading>
      <StepForm
        onSubmit={() =>
          void run(async () => {
            await saveBoat(actions, key.trim(), org.trim(), settings.boatOrg)
            setKey('')
            onNext()
          })
        }
      >
        <Field label="Boat API key" hint={<>Create one in your Boat account with access to create, list, use and delete sandboxes. <A href="https://docs.boat.dev/api/v1">How</A></>}>
          <Input aria-label="boat api key" type="password" autoComplete="off" autoFocus placeholder={settings.boatKey ? 'A key is saved' : 'boat_…'} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Bill a team wallet (optional)</summary>
          <div className="pt-3">
            <Field label="Organization id">
              <Input aria-label="boat organization" autoComplete="off" value={org} onChange={(e) => setOrg(e.target.value)} />
            </Field>
          </div>
        </details>
        <ErrorText>{error}</ErrorText>
        <Primary type="submit" disabled={pending || (!key.trim() && !settings.boatKey)}>
          {pending ? 'Saving…' : 'Continue'}
        </Primary>
      </StepForm>
    </>
  )
}

/** One click builds the base snapshot in the owner's Boat account; the server streams each step. */
export function Prepare({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const snap = useSnapshot()
  const { run, pending, error } = usePending()
  const [manual, setManual] = useState(settings.baseSnapshotId ?? '')
  const manualRun = usePending()
  const build = (force = false) => void run(async () => void (await actions.buildSnapshot(force)))

  if (!snap) return <p role="status" className="text-center text-sm text-muted-foreground">Checking Boat…</p>
  const building = snap.state === 'building'
  const failed = snap.state === 'failed'
  const inUse = settings.baseSnapshotId
  const ready = !!inUse && !building && !failed
  const blocked = !snap.canBuild
  return (
    <>
      <Heading title="Prepare Boat">One click builds the image every session starts from, in your Boat account. It takes a few minutes and counts as one saved snapshot.</Heading>

      {building && (
        <div role="status" aria-label="snapshot build progress" data-testid="snapshot-progress" className="flex flex-col gap-2">
          <p className="text-sm">
            <strong>Step {snap.stepIndex + 1} of {snap.stepCount}:</strong> {snap.message}
          </p>
          <Progress value={((snap.stepIndex + 1) / snap.stepCount) * 100} aria-label="build progress" />
        </div>
      )}
      {!building && failed && (
        <p role="alert" data-testid="snapshot-error" className="text-sm text-destructive">
          The build failed: {snap.error}
          {/[.!?]$/.test(snap.error ?? '') ? '' : '.'}
          {snap.snapshot && inUse === snap.snapshot ? ` Sessions keep using ${snap.snapshot}.` : ''}
        </p>
      )}
      {ready && (
        <p role="status" data-testid="snapshot-ready" className="text-sm">
          Ready. Sessions start from <code>{inUse}</code>.
        </p>
      )}
      {!building && snap.managed && snap.stale && (
        <p role="status" data-testid="snapshot-stale" className="text-sm text-muted-foreground">
          An update is available: this snapshot was built with an older bridge than this app carries.
        </p>
      )}
      {blocked && snap.cannotBuildReason && <p role="status" className="text-sm text-muted-foreground">{snap.cannotBuildReason}</p>}
      <ErrorText>{error}</ErrorText>

      {building ? (
        <Primary disabled>Preparing…</Primary>
      ) : ready ? (
        <>
          <Primary onClick={onNext}>Continue</Primary>
          {snap.managed && snap.stale && (
            <Button variant="ghost" disabled={pending || blocked} onClick={() => build()}>
              Update snapshot
            </Button>
          )}
        </>
      ) : (
        <>
          <Primary disabled={pending || blocked} onClick={() => build()}>
            {pending ? 'Starting…' : failed ? 'Retry' : 'Prepare Boat'}
          </Primary>
          {failed && inUse && (
            <Button variant="ghost" onClick={onNext}>
              Continue with the current snapshot
            </Button>
          )}
        </>
      )}

      {!building && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">I already have a snapshot</summary>
          <div className="pt-3">
            <StepForm
              onSubmit={() =>
                void manualRun.run(async () => {
                  await actions.updateSettings({ baseSnapshotId: manual.trim() })
                  onNext()
                })
              }
            >
              <Field label="Snapshot name or bsh_ share code" hint="Only use share codes from people you trust: a snapshot runs with your agent tokens.">
                <Input aria-label="base snapshot" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="dorks-base-20260101" />
              </Field>
              <ErrorText>{manualRun.error}</ErrorText>
              <Button type="submit" variant="outline" disabled={manualRun.pending || !manual.trim()}>
                Use this snapshot
              </Button>
            </StepForm>
          </div>
        </details>
      )}
    </>
  )
}

type Agent = 'codex' | 'claude'

export function AgentSignIn({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const [agent, setAgent] = useState<Agent>(settings.boatEnvironment || !settings.claudeToken ? 'codex' : 'claude')
  const [environment, setEnvironment] = useState(settings.boatEnvironment ?? '')
  const [token, setToken] = useState('')
  const { run, pending, error } = usePending()
  const configured = !!settings.boatEnvironment || settings.claudeToken
  const typed = agent === 'codex' ? !!environment.trim() && environment.trim() !== (settings.boatEnvironment ?? '') : !!token.trim()
  return (
    <>
      <Heading title="Choose your agent">Pick the one you have a subscription for. You can add the other later in Settings.</Heading>
      <div role="radiogroup" aria-label="agent" className="grid grid-cols-2 gap-2">
        {(['codex', 'claude'] as const).map((a) => (
          <Button key={a} type="button" role="radio" aria-checked={agent === a} variant={agent === a ? 'default' : 'outline'} onClick={() => setAgent(a)}>
            {a === 'codex' ? 'ChatGPT (Codex)' : 'Claude Code'}
          </Button>
        ))}
      </div>
      <StepForm
        onSubmit={() =>
          void run(async () => {
            if (typed) {
              await actions.updateSettings(agent === 'codex' ? { boatEnvironment: environment.trim() } : { claudeToken: token.trim() })
              setToken('')
            }
            onNext()
          })
        }
      >
        {agent === 'codex' ? (
          <Field
            label="Boat environment"
            hint={
              <>
                Connect ChatGPT once in Boat (Agents &amp; Proxying), then create an environment that passes only those agent credentials. Use it only with repositories you trust: the sign-in is readable inside the sandbox. <A href="https://docs.boat.dev/environments/access">Boat setup</A>
              </>
            }
          >
            <Input aria-label="Boat environment" autoFocus value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="dorks-codex" />
          </Field>
        ) : (
          <Field label="Claude token" hint={<>Run <code>claude setup-token</code> in a terminal and paste the result. It is stored encrypted and never shown again.</>}>
            <Input aria-label="claude token" type="password" autoComplete="off" autoFocus placeholder={settings.claudeToken ? 'A token is saved' : 'sk-ant-oat01-…'} value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <Primary type="submit" disabled={pending || (!typed && !configured)}>
          {pending ? 'Saving…' : 'Continue'}
        </Primary>
      </StepForm>
    </>
  )
}

const PERMISSIONS: [string, string][] = [
  ['Contents', 'Read and write'],
  ['Pull requests', 'Read and write'],
  ['Issues', 'Read and write'],
  ['Workflows', 'Read and write'],
  ['Checks', 'Read'],
  ['Commit statuses', 'Read'],
  ['Metadata', 'Read'],
]

export function GitHub({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const [token, setToken] = useState('')
  const [cliError, setCliError] = useState('')
  const { run, pending, error } = usePending()
  const save = (value: string) =>
    run(async () => {
      await actions.updateSettings({ githubToken: value })
      setToken('')
      onNext()
    })
  const useCli = () => {
    setCliError('')
    void readGhToken().then((r) => {
      if (r.ok) return save(r.token)
      setCliError(r.reason === 'declined' ? 'Cancelled: no token was read.' : r.reason === 'missing' ? 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal first.' : 'Could not read the GitHub CLI token.')
    })
  }
  return (
    <>
      <Heading title="Connect GitHub">The agent clones, pushes and opens pull requests as whoever owns this token, and Dorks watches those PRs for you. The token is sent to your sandbox.</Heading>
      {settings.github.configured && (
        <p role="status" data-testid="github-status" className="text-center text-sm">
          A token is saved{settings.github.login ? ` for ${settings.github.login}` : ''}.
        </p>
      )}
      <StepForm onSubmit={() => (token.trim() ? void save(token.trim()) : onNext())}>
        <Field label="Fine-grained token" hint={<>Limit it to the repositories the agent should touch. <A href="https://github.com/settings/personal-access-tokens/new">Create one</A></>}>
          <Input aria-label="github token" type="password" autoComplete="off" autoFocus placeholder={settings.github.configured ? 'A token is saved' : 'github_pat_…'} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Permissions the token needs</summary>
          <ul className="flex flex-col gap-1 pt-3 text-xs">
            {PERMISSIONS.map(([name, access]) => (
              <li key={name} className="flex justify-between">
                <span>{name}</span>
                <span className="text-muted-foreground">{access}</span>
              </li>
            ))}
          </ul>
        </details>
        <ErrorText>{error || cliError}</ErrorText>
        <Primary type="submit" disabled={pending || (!token.trim() && !settings.github.configured)}>
          {pending ? 'Saving…' : 'Continue'}
        </Primary>
      </StepForm>
      {isDesktop() && (
        <div className="flex flex-col gap-2 text-center">
          <Button variant="outline" disabled={pending} onClick={useCli}>
            Use my gh CLI login
          </Button>
          <p className="text-xs text-muted-foreground">A native dialog asks first. The CLI token usually reaches all your repositories and will be sent to your cloud sandbox; a scoped token is safer.</p>
        </div>
      )}
    </>
  )
}

export function Tunnel({ settings, onNext }: StepProps) {
  const tunnel = window.__DORKS__?.tunnel
  const [url, setUrl] = useState(window.__DORKS__?.publicUrl ?? '')
  const { run, pending, error } = usePending()
  const desktop = isDesktop()
  const typed = !!url.trim() && url.trim() !== (window.__DORKS__?.publicUrl ?? '')
  return (
    <>
      <Heading title="Let sandboxes reach this Mac">Your sandboxes run in Boat’s cloud and connect back to this app through a public address. Only the agent connection is exposed, never the app itself.</Heading>
      {settings.publicUrlConfigured && (
        <p role="status" data-testid="tunnel-status" className="text-center text-sm">
          A public URL is set{tunnel ? `. Tunnel: ${tunnel.kind}, ${tunnel.state}${tunnel.error ? ` (${tunnel.error})` : ''}` : ''}.
        </p>
      )}
      <StepForm
        onSubmit={() =>
          void run(async () => {
            if (desktop && typed) await setPublicUrl(url.trim())
            onNext()
          })
        }
      >
        {desktop ? (
          <Field label="Public URL" hint="An https address that forwards to this Mac’s agent port, for example from your tunnel provider.">
            <Input aria-label="public url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://dorks.example.com" />
          </Field>
        ) : (
          !settings.publicUrlConfigured && (
            <p className="text-sm text-muted-foreground">
              Start the server with <code>DORKS_PUBLIC_URL</code> set to that address. The desktop app sets this up for you.
            </p>
          )
        )}
        <ErrorText>{error}</ErrorText>
        <Primary type="submit" disabled={pending || (!typed && !settings.publicUrlConfigured)}>
          {pending ? 'Saving…' : 'Continue'}
        </Primary>
      </StepForm>
      {!settings.publicUrlConfigured && (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              localStorage.setItem(TUNNEL_SKIPPED_KEY, '1')
              onNext()
            }}
          >
            Skip for now
          </Button>
          <p className="text-center text-xs text-muted-foreground">Without it sessions cannot start: sandboxes have no way back to this Mac. You can set it later in Settings.</p>
        </>
      )}
    </>
  )
}

export function Done({ settings, onNext }: StepProps) {
  const ready = canCreate(settings)
  return (
    <>
      <Heading title="You’re all set">Give an agent a repository and a task, then follow its work.</Heading>
      {!settings.publicUrlConfigured && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          No public URL yet, so sessions will not start until you add one in Settings.
        </p>
      )}
      {!ready && (
        <p role="alert" className="text-center text-sm text-destructive">
          Something above is still missing. Go back and finish it.
        </p>
      )}
      <Primary disabled={!ready} onClick={onNext}>
        Start your first session
      </Primary>
    </>
  )
}
