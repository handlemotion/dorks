import { useState } from 'react'
import { useDorksClient, useSecretNames, useSnapshot } from '@dorks/client/react'
import type { Settings, SnapshotStatus } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Progress } from '@dorks/ui/progress'
import { Textarea } from '@dorks/ui/textarea'
import { saveBoat } from '../lib/boat'
import { isDesktop, readGhToken, setPublicUrl } from '../lib/desktop'
import { usePending } from '../lib/pending'

// One form per setting group, shared by the first-run setup and the settings page. Token fields are write-only: the server
// only ever says whether one is stored, and the input is cleared after saving.

function Saved({ show }: { show: boolean }) {
  return show ? (
    <p role="status" className="text-sm text-muted-foreground">
      Saved.
    </p>
  ) : null
}

export function BoatForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [key, setKey] = useState('')
  const [org, setOrg] = useState(settings.boatOrg ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setSaved(false)
        void run(async () => {
          await saveBoat(actions, key.trim(), org.trim(), settings.boatOrg)
          setKey('')
          setSaved(true)
          onSaved?.()
        })
      }}
    >
      <label>
        Boat API key{' '}
        <Input aria-label="boat api key" type="password" autoComplete="off" placeholder={settings.boatKey ? 'A key is saved' : 'boat_…'} value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label>
        Organization (optional) <Input aria-label="boat organization" autoComplete="off" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="only to bill a team wallet" />
      </label>
      <Button type="submit" disabled={pending || (!key && !settings.boatKey)}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <small className="text-muted-foreground">
        Create the key in your Boat account with access to create, list, use and delete sandboxes. It is stored encrypted on this machine and never shown again.
      </small>
      <Saved show={saved} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

/** The build's step and progress bar, while it runs. */
function SnapshotProgress({ snap }: { snap: SnapshotStatus }) {
  return (
    <div role="status" aria-label="snapshot build progress" data-testid="snapshot-progress">
      <p>
        <strong>
          Step {snap.stepIndex + 1} of {snap.stepCount}:
        </strong>{' '}
        {snap.message}
      </p>
      <Progress value={((snap.stepIndex + 1) / snap.stepCount) * 100} aria-label="build progress" />
    </div>
  )
}

/** What the snapshot in use is, when no build is running: failed, ready, out of date or entered by hand. */
function SnapshotNotes({ snap, inUse }: { snap: SnapshotStatus; inUse: string | null }) {
  const failed = snap.state === 'failed'
  const stale = snap.managed && snap.stale
  const keeps = snap.snapshot && inUse === snap.snapshot ? ` Sessions keep using ${snap.snapshot}.` : ''
  return (
    <>
      {failed && (
        <p role="alert" data-testid="snapshot-error">
          The build failed: {snap.error}
          {/[.!?]$/.test(snap.error ?? '') ? '' : '.'}
          {keeps}
        </p>
      )}
      {!failed && inUse && snap.managed && !snap.stale && (
        <p role="status" data-testid="snapshot-ready">
          Ready. Sessions start from <code>{inUse}</code>.
        </p>
      )}
      {stale && (
        <p role="status" data-testid="snapshot-stale">
          An update is available: this snapshot was built with an older bridge than this app carries. Update it so new sessions use the current one. Existing sessions keep what they have.
        </p>
      )}
      {inUse && !snap.managed && (
        <p role="status">
          Sessions start from <code>{inUse}</code>, which you entered by hand. Prepare Boat can build a managed one instead.
        </p>
      )}
    </>
  )
}

/** The one build button the snapshot's state calls for, if any. */
function snapshotAction(snap: SnapshotStatus): { label: string; force?: boolean; variant?: 'outline' } | undefined {
  if (snap.state === 'failed') return { label: 'Retry' }
  if (!snap.managed) return { label: 'Prepare Boat' }
  if (snap.stale) return { label: 'Update snapshot' }
  if (snap.state === 'building') return undefined
  return { label: 'Rebuild', force: true, variant: 'outline' }
}

/**
 * "Prepare Boat": builds the base snapshot in the user's Boat account with one click and follows the build step by step (the
 * server pushes each step over the live stream). A snapshot built some other way can still be entered by hand below.
 */
export function SnapshotForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const snap = useSnapshot()
  const { run, pending, error } = usePending()
  const build = (force = false) => void run(async () => void (await actions.buildSnapshot(force)))

  if (!snap) return <p role="status">Checking the base snapshot…</p>

  const building = snap.state === 'building'
  const blocked = !snap.canBuild
  const action = snapshotAction(snap)

  return (
    <>
      <p>
        Every session starts from a saved snapshot in your Boat account that holds the bridge and the agent tools, with no credentials in it. Dorks builds it for you in a temporary sandbox, saves it,
        and deletes the sandbox. It takes a few minutes and counts as one saved snapshot in your Boat plan.
      </p>

      {building ? <SnapshotProgress snap={snap} /> : <SnapshotNotes snap={snap} inUse={settings.baseSnapshotId} />}

      {blocked && snap.cannotBuildReason && <p role="status">{snap.cannotBuildReason}</p>}

      <div hidden={building}>
        {action && (
          <Button type="button" variant={action.variant} disabled={pending || building || blocked} onClick={() => build(action.force)}>
            {pending ? 'Starting…' : action.label}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <ManualSnapshotForm settings={settings} onSaved={onSaved} />
    </>
  )
}

/** A snapshot built some other way, entered by name or share code. */
function ManualSnapshotForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [manual, setManual] = useState(settings.baseSnapshotId ?? '')
  const [manualSaved, setManualSaved] = useState(false)
  const manualRun = usePending()
  return (
    <details>
      <summary>Use a snapshot I built myself</summary>
      <p>
        Enter the name of a saved snapshot in your Boat account (or a <code>bsh_</code> share code). It must contain the bridge and tools described in{' '}
        <a href="https://github.com/handlemotion/dorks/blob/main/docs/boat.md" target="_blank" rel="noreferrer">
          docs/boat.md
        </a>
        . Only use share codes from people you trust: a snapshot's code runs with your agent tokens.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setManualSaved(false)
          void manualRun.run(async () => {
            await actions.updateSettings({ baseSnapshotId: manual.trim() })
            setManualSaved(true)
            onSaved?.()
          })
        }}
      >
        <label>
          Base snapshot <Input aria-label="base snapshot" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="dorks-base-20260101" />
        </label>
        <Button type="submit" variant="outline" disabled={manualRun.pending || !manual.trim()}>
          {manualRun.pending ? 'Saving…' : 'Save snapshot'}
        </Button>
        <Saved show={manualSaved} />
        {manualRun.error && (
          <p role="alert" className="text-sm text-destructive">
            {manualRun.error}
          </p>
        )}
      </form>
    </details>
  )
}

export function CodexForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [environment, setEnvironment] = useState(settings.boatEnvironment ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const current = settings.boatEnvironment
  return (
    <>
      <p>
        Connect ChatGPT once in Boat’s Agents &amp; Proxying page using its short code. Use a profile containing only ChatGPT, and leave Boat’s account-wide AI credentials proxy off. Create an
        environment using that profile: turn on Agents credentials, turn off Safe for third parties, GitHub, Secrets, Boat credentials, and Proxy AI credentials.{' '}
        <a href="https://docs.boat.dev/environments/access" target="_blank" rel="noreferrer">
          Boat setup instructions
        </a>
        .
      </p>
      <p>Only use this for your own, trusted repositories: Codex needs the sign-in on each sandbox, so code running there can read it.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ boatEnvironment: environment.trim() })
            setSaved(true)
            onSaved?.()
          })
        }}
      >
        <label>
          Boat environment <Input aria-label="Boat environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="dorks-codex" />
        </label>
        <Button type="submit" disabled={pending || !environment.trim()}>
          {pending ? 'Saving…' : 'Save environment'}
        </Button>
      </form>
      <small className="text-muted-foreground">
        {current
          ? `Using ${current} for new Codex sandboxes. Boat checks its access settings when each sandbox starts; this does not confirm ChatGPT is connected yet.`
          : 'A separate Boat environment is needed before creating Codex sessions. Dorks does not store ChatGPT tokens.'}
      </small>
      <Saved show={saved} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function ClaudeForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ claudeToken: token.trim() })
            setToken('')
            setSaved(true)
            onSaved?.()
          })
        }}
      >
        <Input
          aria-label="claude token"
          type="password"
          autoComplete="off"
          placeholder={settings.claudeToken ? 'A token is saved' : 'sk-ant-oat01-…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="submit" disabled={pending || !token.trim()}>
          Save token
        </Button>
      </form>
      <small className="text-muted-foreground">
        Run <code>claude setup-token</code> to get one. Stored encrypted; it is never shown again. Saving a new one replaces the old.
      </small>
      <Saved show={saved} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function GithubForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const [ghError, setGhError] = useState('')
  const { run, pending, error } = usePending()
  const save = (value: string) =>
    run(async () => {
      await actions.updateSettings({ githubToken: value })
      setToken('')
      setSaved(true)
      onSaved?.()
    })
  return (
    <>
      <p data-testid="github-status">{settings.github.configured ? `GitHub token saved${settings.github.login ? ` (${settings.github.login})` : ''}.` : 'No GitHub token yet.'}</p>
      <p>
        Dorks acts on GitHub as whoever owns this token: it clones, pushes and opens pull requests, and watches the PRs it opened. Use a fine-grained personal access token limited to the repositories
        you want it to work on, with read and write access to contents, pull requests, issues and workflows. The token is sent to your sandbox so the agent can push.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          setGhError('')
          void save(token.trim())
        }}
      >
        <Input
          aria-label="github token"
          type="password"
          autoComplete="off"
          placeholder={settings.github.configured ? 'A token is saved' : 'github_pat_…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="submit" disabled={pending || !token.trim()}>
          Save token
        </Button>
      </form>
      {isDesktop() && (
        <div>
          <p>
            <small className="text-muted-foreground">
              Or reuse the account your GitHub CLI is signed in to. Its login token usually has broad access to all your repositories, and it will be sent to your cloud sandbox. A scoped token above
              is safer.
            </small>
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setSaved(false)
              setGhError('')
              void readGhToken().then((r) => {
                if (r.ok) return save(r.token)
                setGhError(
                  r.reason === 'declined'
                    ? 'Cancelled: no token was read.'
                    : r.reason === 'missing'
                      ? 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal first.'
                      : 'Could not read the GitHub CLI token.',
                )
              })
            }}
          >
            Use my GitHub CLI login
          </Button>
        </div>
      )}
      <Saved show={saved} />
      {(error || ghError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || ghError}
        </p>
      )}
    </>
  )
}

export function CommentPolicyForm({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const policy = settings.commentPolicy
  const [mode, setMode] = useState<'all' | 'allowlist'>(policy.mode)
  const [logins, setLogins] = useState(policy.mode === 'allowlist' ? policy.logins.join('\n') : '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const list = logins
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setSaved(false)
        void run(async () => {
          await actions.updateSettings({ commentPolicy: mode === 'all' ? { mode: 'all' } : { mode: 'allowlist', logins: list } })
          setSaved(true)
        })
      }}
    >
      <label>
        Who can wake a session with a PR comment{' '}
        <NativeSelect aria-label="comment policy mode" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'allowlist')}>
          <NativeSelectOption value="all">Anyone</NativeSelectOption>
          <NativeSelectOption value="allowlist">Only these GitHub logins</NativeSelectOption>
        </NativeSelect>
      </label>
      {mode === 'allowlist' && (
        <label>
          Logins (one per line or comma separated; bots by login, e.g. coderabbitai[bot]) <Textarea aria-label="allowed logins" rows={3} value={logins} onChange={(e) => setLogins(e.target.value)} />
        </label>
      )}
      <Button type="submit" disabled={pending || (mode === 'allowlist' && list.length === 0)}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <small className="text-muted-foreground">Comments written by the token’s own account are always ignored: they are the agent’s own.</small>
      <Saved show={saved} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

export function CliSecrets() {
  const { actions } = useDorksClient()
  const names = useSecretNames()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const { run, pending, error } = usePending()
  return (
    <>
      <p>
        <small className="text-muted-foreground">Environment variables for every session, on any machine. A build’s own variable with the same name wins. Values are never displayed.</small>
      </p>
      <ul aria-label="secret names">
        {names?.map((n) => (
          <li key={n}>
            <code>{n}</code>{' '}
            <Button type="button" variant="ghost" size="sm" aria-label={`delete ${n}`} onClick={() => void run(() => actions.deleteSecret(n))}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {names?.length === 0 && <p>No secrets yet.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await actions.setSecret(name.trim(), value)
            setName('')
            setValue('')
          })
        }}
      >
        <Input aria-label="secret name" placeholder="NAME_IN_CAPS" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="secret value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" disabled={pending || !name.trim() || !value}>
          Save secret
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function SleepMinutes({ current }: { current: number }) {
  const { actions } = useDorksClient()
  const [minutes, setMinutes] = useState(String(current))
  const { run, pending, error } = usePending()
  const n = Number(minutes)
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => actions.updateSettings({ sleepMinutes: n }))
        }}
      >
        <Input aria-label="sleep minutes" type="number" min={0.05} max={1440} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} /> minutes
        <Button type="submit" disabled={pending || !Number.isFinite(n) || minutes.trim() === ''}>
          Save
        </Button>
      </form>
      <small className="text-muted-foreground">
        Currently <span data-testid="sleep-current">{current}</span> min. An idle sandbox is paused after this long.
      </small>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

/** Desktop app only: the public https URL that Boat sandboxes use to reach this machine (the tunnel's address). */
export function PublicUrlForm({ settings }: { settings: Settings }) {
  const tunnel = window.__DORKS__?.tunnel
  const [url, setUrl] = useState(window.__DORKS__?.publicUrl ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  if (!isDesktop()) return null
  return (
    <>
      <p data-testid="tunnel-status">
        {settings.publicUrlConfigured ? 'A public URL is set.' : 'No public URL yet.'}
        {tunnel ? ` Tunnel: ${tunnel.kind}, ${tunnel.state}${tunnel.error ? ` (${tunnel.error})` : ''}.` : ''}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          void run(async () => {
            await setPublicUrl(url.trim() || null)
            setSaved(true)
          })
        }}
      >
        <label>
          Public URL <Input aria-label="public url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://dorks.example.com" />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save and restart'}
        </Button>
      </form>
      <small className="text-muted-foreground">
        Boat sandboxes connect out to this address, which must forward to this machine’s bridge port. Only the bridge is exposed, never the app’s own API.
      </small>
      <Saved show={saved} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
