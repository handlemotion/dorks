import type { ReactNode } from 'react'
import { Frame as StepFrame } from '@dorks/onboarding/frame'
import { BrandCircle } from '../BrandCircle'
import type { OnboardingStepId } from '../../lib/onboarding'

// The onboarding pieces live in @dorks/onboarding, shared with dorks.build's cloud onboarding (apps/site).
export { A, Actions, Body, Card, cn, FIELD, Heading, notify, SecretInput, StepForm, useNotifyError } from '@dorks/onboarding/frame'

/** The desktop's first run: its steps (no Boat on Dorks Free), the brand circle behind them, and a drag strip for the title-bar-less window. */
export function Frame({ steps, step, onBack, children }: { steps: OnboardingStepId[]; step: OnboardingStepId; onBack?: () => void; children: ReactNode }) {
  return (
    <StepFrame steps={steps} step={step} onBack={onBack} backdrop={<BrandCircle />} dragRegion>
      {children}
    </StepFrame>
  )
}
