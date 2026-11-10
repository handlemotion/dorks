import { useState } from 'react'
import { useDorksClient, useSecretNames } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { isDesktop, readGhToken, setPublicUrl } from '../lib/desktop'
import { usePending } from '../lib/pending'

// One form per setting group, shared by the first-run setup and the settings page. Token fields are write-only: the server
// only ever says whether one is stored, and the input is cleared after saving.

function Saved({ show }: { show: boolean }) {
  return show ? <p role="status">Saved.</p> : null
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
          await actions.updateSettings({ ...(key ? { boatKey: key } : {}), boatOrg: org.trim() })
          setKey('')
          setSaved(true)
          onSaved?.()
        })
      }}
    >
      <label>Boat API key <input aria-label="boat api key" type="password" autoComplete="off" placeholder={settings.boatKey ? 'A key is saved' : 'boat_…'} value={key} onChange={(e) => setKey(e.target.value)} /></label>
      <label>Organization (optional) <input aria-label="boat organization" autoComplete="off" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="only to bill a team wallet" /></label>
      <Button type="submit" disabled={pending || (!key && !settings.boatKey)}>{pending ? 'Saving…' : 'Save'}</Button>
      <small>Create the key in your Boat account with access to create, list, use and delete sandboxes. It is stored encrypted on this machine and never shown again.</small>
      <Saved show={saved} />
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

export const SNAPSHOT_COMMANDS = `pnpm --filter @dorks/bridge build
boat new --type default --no-env --no-auto-stop     # prints <build-id>
boat scp infra/bridge/dist/cli.mjs <build-id>:dorks-bridge.mjs
boat scp infra/snapshot/boat-install.sh <build-id>:boat-install.sh
boat exec <build-id> -- bash boat-install.sh
boat snapshot <build-id> dorks-base-YYYYMMDD`

export function SnapshotForm({ settings, onSaved }: { settings: Settings; onSaved?: () => void }) {
  const { actions } = useDorksClient()
  const [snapshot, setSnapshot] = useState(settings.baseSnapshotId ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <>
      <p>Every session starts from a saved snapshot in your Boat account that holds the bridge and the agent tools, with no credentials in it. Build it once from a checkout of this repository:</p>
      <pre aria-label="snapshot build commands"><code>{SNAPSHOT_COMMANDS}</code></pre>
      <p>Wait until Boat reports the snapshot <code>ready</code>, then enter its name or id. See <a href="https://github.com/handlemotion/dorks/blob/main/docs/boat.md" target="_blank" rel="noreferrer">docs/boat.md</a> for details.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ baseSnapshotId: snapshot.trim() })
            setSaved(true)
            onSaved?.()
          })
        }}
      >
        <label>Base snapshot <input aria-label="base snapshot" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} placeholder="dorks-base-20260101" /></label>
        <Button type="submit" disabled={pending || !snapshot.trim()}>{pending ? 'Saving…' : 'Save snapshot'}</Button>
        <Saved show={saved} />
        {error && <p role="alert">{error}</p>}
      </form>
    </>
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
      <p>Connect ChatGPT once in Boat’s Agents &amp; Proxying page using its short code. Use a profile containing only ChatGPT, and leave Boat’s account-wide AI credentials proxy off. Create an environment using that profile: turn on Agents credentials, turn off Safe for third parties, GitHub, Secrets, Boat credentials, and Proxy AI credentials. <a href="https://docs.boat.dev/environments/access" target="_blank" rel="noreferrer">Boat setup instructions</a>.</p>
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
        <label>Boat environment <input aria-label="Boat environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="dorks-codex" /></label>
        <Button type="submit" disabled={pending || !environment.trim()}>{pending ? 'Saving…' : 'Save environment'}</Button>
      </form>
      <small>{current ? `Using ${current} for new Codex sandboxes. Boat checks its access settings when each sandbox starts; this does not confirm ChatGPT is connected yet.` : 'A separate Boat environment is needed before creating Codex sessions. Dorks does not store ChatGPT tokens.'}</small>
      <Saved show={saved} />
      {error && <p role="alert">{error}</p>}
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
        <input aria-label="claude token" type="password" autoComplete="off" placeholder={settings.claudeToken ? 'A token is saved' : 'sk-ant-oat01-…'} value={token} onChange={(e) => setToken(e.target.value)} />
        <Button type="submit" disabled={pending || !token.trim()}>Save token</Button>
      </form>
      <small>Run <code>claude setup-token</code> to get one. Stored encrypted; it is never shown again. Saving a new one replaces the old.</small>
      <Saved show={saved} />
      {error && <p role="alert">{error}</p>}
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
      <p>Dorks acts on GitHub as whoever owns this token: it clones, pushes and opens pull requests, and watches the PRs it opened. Use a fine-grained personal access token limited to the repositories you want it to work on, with read and write access to contents, pull requests, issues and workflows. The token is sent to your sandbox so the agent can push.</p>
      <form onSubmit={(e) => { e.preventDefault(); setSaved(false); setGhError(''); void save(token.trim()) }}>
        <input aria-label="github token" type="password" autoComplete="off" placeholder={settings.github.configured ? 'A token is saved' : 'github_pat_…'} value={token} onChange={(e) => setToken(e.target.value)} />
        <Button type="submit" disabled={pending || !token.trim()}>Save token</Button>
      </form>
      {isDesktop() && (
        <div>
          <p><small>Or reuse the account your GitHub CLI is signed in to. Its login token usually has broad access to all your repositories, and it will be sent to your cloud sandbox. A scoped token above is safer.</small></p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setSaved(false)
              setGhError('')
              void readGhToken().then((r) => {
                if (r.ok) return save(r.token)
                setGhError(r.reason === 'declined' ? 'Cancelled: no token was read.' : r.reason === 'missing' ? 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal first.' : 'Could not read the GitHub CLI token.')
              })
            }}
          >
            Use my GitHub CLI login
          </Button>
        </div>
      )}
      <Saved show={saved} />
      {(error || ghError) && <p role="alert">{error || ghError}</p>}
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
  const list = logins.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean)
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
        <select aria-label="comment policy mode" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'allowlist')}>
          <option value="all">Anyone</option>
          <option value="allowlist">Only these GitHub logins</option>
        </select>
      </label>
      {mode === 'allowlist' && (
        <label>Logins (one per line or comma separated; bots by login, e.g. coderabbitai[bot]) <textarea aria-label="allowed logins" rows={3} value={logins} onChange={(e) => setLogins(e.target.value)} /></label>
      )}
      <Button type="submit" disabled={pending || (mode === 'allowlist' && list.length === 0)}>{pending ? 'Saving…' : 'Save'}</Button>
      <small>Comments written by the token’s own account are always ignored: they are the agent’s own.</small>
      <Saved show={saved} />
      {error && <p role="alert">{error}</p>}
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
      <p><small>Exported as environment variables inside the sandbox. Values are never displayed.</small></p>
      <ul aria-label="secret names">
        {names?.map((n) => (
          <li key={n}>
            <code>{n}</code> <Button type="button" variant="ghost" size="sm" aria-label={`delete ${n}`} onClick={() => void run(() => actions.deleteSecret(n))}>Remove</Button>
          </li>
        ))}
      </ul>
      {names?.length === 0 && <p>No secrets yet.</p>}
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await actions.setSecret(name.trim(), value); setName(''); setValue('') }) }}>
        <input aria-label="secret name" placeholder="NAME_IN_CAPS" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="secret value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" disabled={pending || !name.trim() || !value}>Save secret</Button>
      </form>
      {error && <p role="alert">{error}</p>}
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
      <form onSubmit={(e) => { e.preventDefault(); void run(() => actions.updateSettings({ sleepMinutes: n })) }}>
        <input aria-label="sleep minutes" type="number" min={0.05} max={1440} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} /> minutes
        <Button type="submit" disabled={pending || !Number.isFinite(n) || minutes.trim() === ''}>Save</Button>
      </form>
      <small>Currently <span data-testid="sleep-current">{current}</span> min. An idle sandbox is paused after this long.</small>
      {error && <p role="alert">{error}</p>}
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
      <p data-testid="tunnel-status">{settings.publicUrlConfigured ? 'A public URL is set.' : 'No public URL yet.'}{tunnel ? ` Tunnel: ${tunnel.kind}, ${tunnel.state}${tunnel.error ? ` (${tunnel.error})` : ''}.` : ''}</p>
      <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void run(async () => { await setPublicUrl(url.trim() || null); setSaved(true) }) }}>
        <label>Public URL <input aria-label="public url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://dorks.example.com" /></label>
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save and restart'}</Button>
      </form>
      <small>Boat sandboxes connect out to this address, which must forward to this machine’s bridge port. Only the bridge is exposed, never the app’s own API.</small>
      <Saved show={saved} />
      {error && <p role="alert">{error}</p>}
    </>
  )
}
