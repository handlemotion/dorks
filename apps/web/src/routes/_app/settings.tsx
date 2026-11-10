import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { api } from '@dorks/convex/client'
import { INSTALL_STATE_KEY } from '../../lib/githubInstall'
import { usePending } from '../../lib/pending'

export const Route = createFileRoute('/_app/settings')({ component: Settings })

const GITHUB_APP_SLUG = import.meta.env.VITE_GITHUB_APP_SLUG as string | undefined

function Settings() {
  const onboarding = useQuery(api.settings.onboarding)
  if (!onboarding) return <p>Loading…</p>
  return (
    <div>
      <header>
        <h1>Settings</h1>
        <Link to="/dorks">Back to dorks</Link>
      </header>
      <Checklist claudeToken={onboarding.claudeToken} github={onboarding.github} codexBoatEnvironment={onboarding.codexBoatEnvironment} />
      <CodexConnection current={onboarding.codexBoatEnvironment} />
      <ClaudeToken />
      <GithubApp linked={onboarding.github} />
      <CliSecrets />
      <SleepMinutes current={onboarding.sleepMinutes} />
    </div>
  )
}

function Checklist({ claudeToken, github, codexBoatEnvironment }: { claudeToken: boolean; github: boolean; codexBoatEnvironment: string | null }) {
  return (
    <section aria-label="onboarding checklist">
      <h2>Onboarding</h2>
      <ul>
        <li data-testid="check-claude">{claudeToken ? '✅' : '⬜'} Claude token (only for Claude dorks)</li>
        <li data-testid="check-github">{github ? '✅' : '⬜'} GitHub App installed</li>
        <li data-testid="check-codex">{codexBoatEnvironment ? '✅' : '⬜'} Boat environment saved (for cloud Codex dorks)</li>
      </ul>
      <p role="status" data-testid="onboarding-status">{!github ? 'Install the GitHub App to create dorks.' : codexBoatEnvironment ? 'Boat environment saved. Make sure ChatGPT is connected in Boat before creating a Codex dork.' : 'To use Codex in Boat, connect ChatGPT once and save your Boat environment below.'}</p>
    </section>
  )
}

function CodexConnection({ current }: { current: string | null }) {
  const save = useMutation(api.settings.setCodexBoatEnvironment)
  const [environment, setEnvironment] = useState(current ?? '')
  const { run, pending, error } = usePending()
  useEffect(() => setEnvironment(current ?? ''), [current])
  return (
    <section>
      <h2>ChatGPT for Codex</h2>
      <p>Connect ChatGPT once in Boat’s Agents &amp; Proxying page using its short code. Use a profile containing only ChatGPT; the default profile works while it contains no other AI keys. Leave Boat’s account-wide AI credentials proxy off. Create an environment using that profile: turn on Agents credentials, turn off Safe for third parties, GitHub, Secrets, Boat credentials, and Proxy AI credentials. <a href="https://docs.boat.dev/environments/access" target="_blank" rel="noreferrer">Boat setup instructions</a>.</p>
      <p>Only use this for your personal, trusted repos. Codex needs the sign-in on each box, so code running there can read it. This avoids Boat’s paid credentials proxy.</p>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => save({ environment })) }}>
        <label>Boat environment <input aria-label="Boat environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="dorks-codex" /></label>
        <button type="submit" disabled={pending || !environment.trim()}>{pending ? 'Saving…' : 'Save environment'}</button>
      </form>
      <small>{current ? `Using ${current} for new Codex boxes. Boat checks its access settings when each box starts; this does not confirm ChatGPT is connected yet.` : 'A separate Boat environment is needed before creating cloud Codex dorks. Dorks does not store ChatGPT tokens.'}</small>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function ClaudeToken() {
  const set = useMutation(api.settings.setClaudeToken)
  const [token, setToken] = useState('')
  const { run, pending, error } = usePending()
  const [saved, setSaved] = useState(false)
  return (
    <section>
      <h2>Claude token</h2>
      <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void run(async () => { await set({ token }); setToken(''); setSaved(true) }) }}>
        <input aria-label="claude token" type="password" autoComplete="off" placeholder="sk-ant-oat01-…" value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit" disabled={pending || !token.trim()}>Save token</button>
      </form>
      <small>Stored encrypted; it is never shown again. Saving a new one replaces the old.</small>
      {saved && <p role="status">Saved.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function GithubApp({ linked }: { linked: boolean }) {
  // CSRF-style binding: GitHub echoes `state` back to the callback, which only links automatically if it matches what this browser
  // generated. Otherwise anyone could send a signed-in user a callback URL for the *attacker's* installation.
  const [state, setState] = useState('')
  useEffect(() => {
    const s = crypto.randomUUID()
    sessionStorage.setItem(INSTALL_STATE_KEY, s)
    setState(s)
  }, [])
  return (
    <section>
      <h2>GitHub</h2>
      <p data-testid="github-status">{linked ? 'GitHub App installed.' : 'GitHub App not installed.'}</p>
      {!GITHUB_APP_SLUG ? (
        <p role="alert">VITE_GITHUB_APP_SLUG is not set, so the install link is unavailable.</p>
      ) : (
        state && <a href={`https://github.com/apps/${encodeURIComponent(GITHUB_APP_SLUG)}/installations/new?state=${state}`}>{linked ? 'Install on more repositories / reinstall' : 'Install GitHub App'}</a>
      )}
    </section>
  )
}

function CliSecrets() {
  const names = useQuery(api.settings.secretNames)
  const set = useMutation(api.settings.setCliSecret)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const { run, pending, error } = usePending()
  return (
    <section>
      <h2>CLI secrets</h2>
      <p><small>Exported as environment variables inside the sandbox. Values are never displayed.</small></p>
      <ul aria-label="secret names">{names?.map((n) => <li key={n}><code>{n}</code></li>)}</ul>
      {names?.length === 0 && <p>No secrets yet.</p>}
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await set({ name: name.trim(), value }); setName(''); setValue('') }) }}>
        <input aria-label="secret name" placeholder="NAME_IN_CAPS" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="secret value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={pending || !name.trim() || !value}>Save secret</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function SleepMinutes({ current }: { current: number }) {
  const set = useMutation(api.settings.setSleepMinutes)
  const [minutes, setMinutes] = useState(String(current))
  useEffect(() => setMinutes(String(current)), [current])
  const { run, pending, error } = usePending()
  const n = Number(minutes)
  return (
    <section>
      <h2>Sleep after idle</h2>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => set({ minutes: n })) }}>
        <input aria-label="sleep minutes" type="number" min={0.05} max={1440} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} /> minutes
        <button type="submit" disabled={pending || !Number.isFinite(n) || minutes.trim() === ''}>Save</button>
      </form>
      <small>Currently <span data-testid="sleep-current">{current}</span> min. An idle sandbox is paused after this long.</small>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
