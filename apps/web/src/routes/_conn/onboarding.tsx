import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useSettings } from '@dorks/client/react'
import { BrandCircle } from '../../components/BrandCircle'
import { Frame } from '../../components/onboarding/Frame'
import { AgentSignIn, BoatKey, GitHub, Intro, type StepProps } from '../../components/onboarding/Steps'
import { setWindowMode } from '../../lib/desktop'
import { firstOnboardingStep, ONBOARDING_STEPS, onboarded, readWelcomed, type OnboardingStepId } from '../../lib/onboarding'

export const Route = createFileRoute('/_conn/onboarding')({ component: Onboarding })

// One view per step id. A Record makes a step without a view (or a view without a step) a type error, and the page renders the
// view and the dots from the same `step`, so the two cannot drift apart.
const VIEWS: Record<OnboardingStepId, (props: StepProps) => React.JSX.Element> = { intro: Intro, boat: BoatKey, agent: AgentSignIn, github: GitHub }

/**
 * First run: one full page per step, starting at the first thing the server says is still missing (so quitting halfway and
 * reopening resumes). No sidebar, no app chrome, and in the desktop app no traffic lights until the owner finishes. The last
 * step leads straight into the app, where the first session is created.
 */
function Onboarding() {
  const settings = useSettings()
  const navigate = useNavigate()
  const [step, setStep] = useState<OnboardingStepId | null>(null)
  const [finishing, setFinishing] = useState(false)
  useEffect(() => setWindowMode('onboarding'), [])
  // Leave only once the settings the app reads say onboarding is answered (the live stream refreshes them a moment after the last
  // save); leaving earlier would send the app straight back here.
  useEffect(() => {
    if (!finishing || !settings || !onboarded(settings)) return
    setWindowMode('app')
    void navigate({ to: '/dorks', search: {} })
  }, [finishing, settings, navigate])
  // Once the real settings arrive, open at the first unfinished step. Nothing unfinished (the owner reran setup from Settings):
  // open at Boat so each answer can be reviewed.
  useEffect(() => {
    if (settings && step === null) setStep(firstOnboardingStep(settings, readWelcomed()) ?? 'boat')
  }, [settings, step])
  if (!settings || step === null) {
    return (
      <main className="app-backdrop relative isolate flex min-h-svh items-center justify-center overflow-clip">
        <BrandCircle />
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      </main>
    )
  }

  const index = ONBOARDING_STEPS.indexOf(step)
  const next = () => {
    const to = ONBOARDING_STEPS[index + 1]
    if (to) setStep(to)
    else setFinishing(true)
  }
  const View = VIEWS[step]
  return (
    <Frame step={step} onBack={index > 0 ? () => setStep(ONBOARDING_STEPS[index - 1]!) : undefined}>
      <View settings={settings} onNext={next} />
    </Frame>
  )
}
