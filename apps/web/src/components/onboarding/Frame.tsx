import type { ReactNode } from 'react'
import { Frame as StepFrame } from '@dorks/onboarding/frame'
import { BrandCircle } from '../BrandCircle'
import { ONBOARDING_STEPS, type OnboardingStepId } from '../../lib/onboarding'

// The onboarding pieces live in @dorks/onboarding, shared with dorks.build's cloud onboarding (apps/site).
export { A, Actions, Body, Card, cn, FIELD, Heading, notify, SecretInput, StepForm, useNotifyError } from '@dorks/onboarding/frame'

/** The desktop's first run: its four steps, the brand circle behind them, and a drag strip for the title-bar-less window. */
export function Frame({ step, onBack, children }: { step: OnboardingStepId; onBack?: () => void; children: ReactNode }) {
  return (
    <StepFrame steps={ONBOARDING_STEPS} step={step} onBack={onBack} backdrop={<BrandCircle />} dragRegion>
      {children}
    </StepFrame>
  )
}
