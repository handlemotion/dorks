import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { BoatForm, ClaudeForm, CodexForm, GithubForm, SnapshotForm } from '../../components/SettingsForms'
import { canCreate, firstIncomplete, SETUP_SKIPPED_KEY, STEPS, stepDone, type StepId } from '../../lib/onboarding'

export const Route = createFileRoute('/_conn/setup')({ component: Setup })

const INTRO: Record<StepId, string> = {
  boat: 'Sessions run in sandboxes in your own Boat account. Paste an API key so Dorks can create them.',
  snapshot: 'New sessions are restored from a saved snapshot that has the bridge and tools installed.',
  agents: 'Sign in at least one agent. Codex uses your ChatGPT subscription through Boat; Claude Code uses a token. You can add the other later.',
  github: 'Give the agent a GitHub token so it can clone, push and open pull requests, and so Dorks can keep watching them.',
}

/** First-run guide: one step at a time, starting at the first thing still missing. */
function Setup() {
  const settings = useSettings()
  const navigate = useNavigate()
  const [step, setStep] = useState<StepId | null>(null)
  // Once the real settings arrive, open at the first unfinished step (or the finish screen).
  useEffect(() => {
    if (settings && step === null) setStep(firstIncomplete(settings) ?? 'github')
  }, [settings, step])
  if (!settings || step === null) return <main className="gate"><p role="status">Loading…</p></main>

  const done = stepDone(settings)
  const index = STEPS.findIndex((s) => s.id === step)
  const next = STEPS[index + 1]?.id
  const complete = canCreate(settings)
  const skip = () => {
    sessionStorage.setItem(SETUP_SKIPPED_KEY, '1')
    void navigate({ to: '/dorks', search: {} })
  }

  return (
    <main className="setup">
      <header>
        <h1>Set up Dorks</h1>
        <ol className="setup-steps" aria-label="setup steps">
          {STEPS.map((s) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined} data-done={done[s.id] || undefined}>
              <button type="button" onClick={() => setStep(s.id)}>{done[s.id] ? '✓ ' : ''}{s.title}</button>
            </li>
          ))}
        </ol>
      </header>
      <section className="setup-step" aria-label={STEPS[index]?.title}>
        <h2>{STEPS[index]?.title}</h2>
        <p>{INTRO[step]}</p>
        {step === 'boat' && <BoatForm settings={settings} onSaved={() => setStep('snapshot')} />}
        {step === 'snapshot' && <SnapshotForm settings={settings} onSaved={() => setStep('agents')} />}
        {step === 'agents' && (
          <>
            <h3>ChatGPT for Codex</h3>
            <CodexForm settings={settings} />
            <h3>Claude Code</h3>
            <ClaudeForm settings={settings} />
          </>
        )}
        {step === 'github' && <GithubForm settings={settings} />}
      </section>
      <footer className="setup-nav">
        <Button variant="ghost" onClick={skip}>Skip for now</Button>
        {index > 0 && <Button variant="outline" onClick={() => setStep(STEPS[index - 1]!.id)}>Back</Button>}
        {next ? (
          <Button onClick={() => setStep(next)} disabled={!done[step]}>Next</Button>
        ) : (
          <Button render={<Link to="/dorks" search={{}} />} disabled={!complete}>Start your first session</Button>
        )}
      </footer>
      {!next && complete && !settings.publicUrlConfigured && (
        <p role="status">Heads up: no public URL is configured yet, so sandboxes cannot reach this machine. The desktop app sets this up; when running the server by hand, set <code>DORKS_PUBLIC_URL</code>.</p>
      )}
    </main>
  )
}
