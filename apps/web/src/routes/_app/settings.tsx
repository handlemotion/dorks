import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { api } from '@dorks/convex/client'
import { ENGINE_LABEL, type Engine } from '@dorks/shared'
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
      <Checklist claudeToken={onboarding.claudeToken} github={onboarding.github} engine={onboarding.defaultEngine} />
      <AgentEngine engine={onboarding.defaultEngine} model={onboarding.opencodeModel} providerKey={onboarding.providerKey} />
      <ClaudeToken />
      <GithubApp linked={onboarding.github} />
      <CliSecrets />
      <SleepMinutes current={onboarding.sleepMinutes} />
    </div>
  )
}

function Checklist({ claudeToken, github, engine }: { claudeToken: boolean; github: boolean; engine: Engine }) {
  // The Claude token is only needed to run Claude Code; OpenCode authenticates with a provider key from the CLI secrets.
  const done = github && (engine !== 'claude' || claudeToken)
  return (
    <section aria-label="onboarding checklist">
      <h2>Onboarding</h2>
      <ul>
        <li data-testid="check-claude">{claudeToken ? '✅' : '⬜'} Claude token{engine === 'claude' ? '' : ' (only for Claude Code dorks)'}</li>
        <li data-testid="check-github">{github ? '✅' : '⬜'} GitHub App installed</li>
      </ul>
      <p role="status" data-testid="onboarding-status">{done ? 'Ready: you can create dorks.' : 'Finish the steps above to create dorks.'}</p>
    </section>
  )
}

function AgentEngine({ engine, model, providerKey }: { engine: Engine; model: string | null; providerKey: boolean }) {
  const set = useMutation(api.settings.setEngineDefaults)
  const [draft, setDraft] = useState(model ?? '')
  useEffect(() => setDraft(model ?? ''), [model])
  const { run, pending, error } = usePending()
  return (
    <section aria-label="agent engine">
      <h2>Agent engine</h2>
      <p><small>The harness new dorks run: the program that gives the model its tools and runs its loop. Each dork keeps the engine it was created with; you can still pick another one per dork when you create it.</small></p>
      <label>Default for new dorks{' '}
        <select aria-label="default engine" value={engine} disabled={pending} onChange={(e) => void run(() => set({ defaultEngine: e.target.value as Engine }))}>
          {(Object.keys(ENGINE_LABEL) as Engine[]).map((k) => <option key={k} value={k}>{ENGINE_LABEL[k]}</option>)}
        </select>
      </label>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => set({ opencodeModel: draft.trim() || null })) }}>
        <input aria-label="opencode model" placeholder="anthropic/claude-sonnet-4-5" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={pending || draft.trim() === (model ?? '')}>Save model</button>
      </form>
      <small>OpenCode model as <code>provider/model</code>. Leave empty to let OpenCode pick from the providers it has keys for. Currently <span data-testid="opencode-model">{model ?? 'OpenCode default'}</span>.</small>
      <p data-testid="provider-key-status"><small>{providerKey
        ? 'A provider key is saved under CLI secrets.'
        : 'OpenCode needs a model provider key: save one under CLI secrets, e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY. (Your Claude token is not used by OpenCode.)'}</small></p>
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
