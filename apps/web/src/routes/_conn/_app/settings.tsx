import { createFileRoute, Link } from '@tanstack/react-router'
import { useSettings } from '@dorks/client/react'
import { BoatForm, ClaudeForm, CliSecrets, CodexForm, CommentPolicyForm, GithubForm, PublicUrlForm, SleepMinutes, SnapshotForm } from '../../../components/SettingsForms'
import { isDesktop } from '../../../lib/desktop'
import { STEPS, stepDone } from '../../../lib/onboarding'

export const Route = createFileRoute('/_conn/_app/settings')({ component: Settings })

function Settings() {
  const settings = useSettings()
  if (!settings) return <p>Loading…</p>
  const done = stepDone(settings)
  return (
    <div className="setup">
      <header className="setup-header">
        <h1>Settings</h1>
        <Link to="/dorks">Back to dorks</Link>
      </header>
      <section className="setup-step" aria-label="setup checklist">
        <h2>Setup</h2>
        <ul>
          {STEPS.map((s) => (
            <li key={s.id} data-testid={`check-${s.id}`}>{done[s.id] ? '✅' : '⬜'} {s.title}</li>
          ))}
          <li data-testid="check-tunnel">{settings.publicUrlConfigured ? '✅' : '⬜'} Public URL for sandboxes (the tunnel)</li>
        </ul>
        {!settings.publicUrlConfigured && <p role="status">No public URL is configured, so sandboxes cannot reach this machine. The desktop app sets it up; when running the server by hand, set <code>DORKS_PUBLIC_URL</code>.</p>}
        <p><Link to="/onboarding">Run the guided setup</Link></p>
      </section>
      <section className="setup-step">
        <h2>Boat</h2>
        <BoatForm settings={settings} />
      </section>
      <section className="setup-step">
        <h2>Base snapshot</h2>
        <SnapshotForm settings={settings} />
      </section>
      <section className="setup-step">
        <h2>ChatGPT for Codex</h2>
        <CodexForm settings={settings} />
      </section>
      <section className="setup-step">
        <h2>Claude token</h2>
        <ClaudeForm settings={settings} />
      </section>
      <section className="setup-step">
        <h2>GitHub</h2>
        <GithubForm settings={settings} />
      </section>
      {isDesktop() && (
        <section className="setup-step">
          <h2>Public URL</h2>
          <PublicUrlForm settings={settings} />
        </section>
      )}
      <section className="setup-step">
        <h2>PR comments</h2>
        <CommentPolicyForm settings={settings} />
      </section>
      <section className="setup-step">
        <h2>CLI secrets</h2>
        <CliSecrets />
      </section>
      <section className="setup-step">
        <h2>Sleep after idle</h2>
        <SleepMinutes current={settings.sleepMinutes} />
      </section>
    </div>
  )
}
