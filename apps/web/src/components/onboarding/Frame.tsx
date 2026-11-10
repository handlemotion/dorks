import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@dorks/ui/button'
import { ONBOARDING_STEPS, type OnboardingStepId } from '../../lib/onboarding'

/**
 * The whole window for one onboarding step: an empty page with a centered column and progress dots. No sidebar or app chrome.
 * The top strip is a drag region because the desktop window has no title bar while onboarding.
 */
export function Frame({ step, onBack, children }: { step: OnboardingStepId; onBack?: () => void; children: ReactNode }) {
  const index = ONBOARDING_STEPS.indexOf(step)
  return (
    <div className="app-backdrop relative flex min-h-svh flex-col text-foreground" data-testid="onboarding" data-step={step}>
      <div data-tauri-drag-region className="h-10 shrink-0" />
      {onBack && (
        <Button variant="ghost" size="sm" className="absolute top-12 left-4 text-muted-foreground" onClick={onBack}>
          ← Back
        </Button>
      )}
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-12">{children}</main>
      <ol aria-label={`Step ${index + 1} of ${ONBOARDING_STEPS.length}`} className="flex shrink-0 justify-center gap-2 pb-8">
        {ONBOARDING_STEPS.map((id, i) => (
          <li key={id} aria-current={i === index ? 'step' : undefined} className={`size-1.5 rounded-full ${i === index ? 'bg-foreground' : i < index ? 'bg-foreground/40' : 'bg-foreground/15'}`} />
        ))}
      </ol>
    </div>
  )
}

export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
    </header>
  )
}

/** A form that is the step: fields stacked, one primary action under them. */
export function StepForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Plain-words failure under the field that caused it. */
export function ErrorText({ children }: { children?: string }) {
  return children ? (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  ) : null
}

export const Primary = ({ children, ...props }: ComponentProps<typeof Button>) => (
  <Button size="lg" className="w-full" {...props}>
    {children}
  </Button>
)

export const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
    {children}
  </a>
)
