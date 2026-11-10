import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useSettings } from '@dorks/client/react'
import { Frame } from '../../components/onboarding/Frame'
import { AgentSignIn, BoatKey, Done, GitHub, Prepare, Tunnel, Welcome } from '../../components/onboarding/Steps'
import { setWindowMode } from '../../lib/desktop'
import { firstOnboardingStep, ONBOARDING_STEPS, readFlags, type OnboardingStepId } from '../../lib/onboarding'

export const Route = createFileRoute('/_conn/onboarding')({ component: Onboarding })

/**
 * First run: one full page per step, starting at the first thing the server says is still missing (so quitting halfway and
 * reopening resumes). No sidebar, no app chrome, and in the desktop app no traffic lights until the owner finishes.
 */
function Onboarding() {
  const settings = useSettings()
  const navigate = useNavigate()
  const [step, setStep] = useState<OnboardingStepId | null>(null)
  useEffect(() => setWindowMode('onboarding'), [])
  // Once the real settings arrive, open at the first unfinished step.
  useEffect(() => {
    if (settings && step === null) setStep(firstOnboardingStep(settings, readFlags()))
  }, [settings, step])
  if (!settings || step === null) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <p role="status" className="text-sm text-muted-foreground">Loading…</p>
      </main>
    )
  }

  const index = ONBOARDING_STEPS.indexOf(step)
  const next = () => {
    const to = ONBOARDING_STEPS[index + 1]
    if (to) setStep(to)
  }
  const finish = () => {
    setWindowMode('app')
    void navigate({ to: '/dorks', search: {} })
  }
  const props = { settings, onNext: next }
  return (
    <Frame step={step} onBack={index > 0 ? () => setStep(ONBOARDING_STEPS[index - 1]!) : undefined}>
      {step === 'welcome' && <Welcome {...props} />}
      {step === 'boat' && <BoatKey {...props} />}
      {step === 'prepare' && <Prepare {...props} />}
      {step === 'agent' && <AgentSignIn {...props} />}
      {step === 'github' && <GitHub {...props} />}
      {step === 'tunnel' && <Tunnel {...props} />}
      {step === 'done' && <Done {...props} onNext={finish} />}
    </Frame>
  )
}
