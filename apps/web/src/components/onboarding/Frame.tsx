import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { BrandCircle } from '../BrandCircle'
import { ONBOARDING_STEPS, type OnboardingStepId } from '../../lib/onboarding'

/** Joins class names. The callers here never pass two classes that fight, so no Tailwind merging is needed. */
export const cn = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

const BackContext = createContext<(() => void) | undefined>(undefined)

/**
 * The whole window for one onboarding step: the backdrop with the brand circle, a 450px column in the middle and the progress dots
 * at the bottom. No sidebar or app chrome. The dots are drawn from the same `step` the column shows, so they cannot disagree. The
 * top strip is a drag region because the desktop window has no title bar while onboarding.
 */
export function Frame({ step, onBack, children }: { step: OnboardingStepId; onBack?: () => void; children: ReactNode }) {
  const index = ONBOARDING_STEPS.indexOf(step)
  return (
    <div className="app-backdrop relative isolate flex min-h-svh flex-col overflow-clip tracking-[-0.02em] text-foreground" data-testid="onboarding" data-step={step}>
      <BrandCircle />
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      <BackContext.Provider value={onBack}>
        {/* Keyed by step so each step enters on its own instead of morphing out of the last one. */}
        <main key={step} className="mx-auto flex w-full max-w-[546px] flex-1 flex-col justify-center gap-8 p-12 pb-20 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300">
          {children}
        </main>
      </BackContext.Provider>
      <ol aria-label={`Step ${index + 1} of ${ONBOARDING_STEPS.length}`} className="absolute inset-x-0 bottom-12 flex justify-center gap-3">
        {ONBOARDING_STEPS.map((id, i) => (
          <li key={id} aria-current={i === index ? 'step' : undefined} className={cn('size-2 rounded-full transition-colors duration-300', i === index ? 'bg-brand' : 'bg-foreground/15')} />
        ))}
      </ol>
    </div>
  )
}

/** The step's title and a line or two under it. Never three: cut the copy, don't widen the column. */
export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col items-center gap-3 text-center">
      <h1 className="text-lg leading-[normal] font-medium">{title}</h1>
      {children && <p className="max-w-[400px] text-sm leading-5 text-balance text-muted-foreground">{children}</p>}
    </header>
  )
}

/** Heading and card together, 24px apart; the actions sit 32px under them (the column's gap). */
export function Body({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>
}

/**
 * The step's one surface: white on the #f2f2f2 app fill, with the --surface-line hairline in light because that pair is under 1.15:1
 * (`contrast.mjs`); dark separates on fill alone. Same 6px radius as the controls.
 */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('relative overflow-hidden rounded-(--control-radius) border border-surface-line bg-surface text-sm leading-[normal]', className)} {...props} />
}

/**
 * The step navigation: Back (when there is a step behind) and the primary action, both 40px pills. Pills are only for moving between
 * steps; every other control keeps the 6px radius.
 */
export function Actions({ children, ...primary }: ComponentProps<typeof Button>) {
  const onBack = useContext(BackContext)
  return (
    <div className="flex items-center justify-center gap-2 [--control-radius:var(--radius-pill)]">
      {onBack && (
        <Button type="button" variant="ghost" size="lg" className="text-muted-foreground" onClick={onBack}>
          Back
        </Button>
      )}
      <Button size="lg" {...primary}>
        {children}
      </Button>
    </div>
  )
}

/** A form that is the step, so Enter in a field submits it. */
export function StepForm({ onSubmit, className, children }: { onSubmit: () => void; className?: string; children: ReactNode }) {
  return (
    <form
      className={cn('flex flex-col gap-8', className)}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}

/**
 * Validation and failures go to a toast (top center), not under the field: the step's buttons stay enabled, and pressing one with
 * something missing says what. The same message twice replaces itself instead of stacking.
 */
export const notify = (message: string) => void toast.error(message, { id: message })

/** Toasts a `usePending` error each time one is set. */
export function useNotifyError(error: string) {
  useEffect(() => {
    if (error) notify(error)
  }, [error])
}

/**
 * A key or token field: masked, with an eye at the right to show what was pasted. Masked dots get letter spacing so they don't read as
 * a squeezed smudge; the placeholder keeps normal spacing.
 */
export function SecretInput({ className, ...props }: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={cn(className, 'pr-11', !shown && '[&:not(:placeholder-shown)]:tracking-[0.25em]')} />
      {/* Centred with margins, not a translate: Button's press nudge is a translate too and would replace it. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute inset-y-0 right-1 my-auto text-muted-foreground hover:text-foreground"
        aria-label={shown ? 'Hide' : 'Show'}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  )
}

export const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="whitespace-nowrap text-foreground underline underline-offset-4">
    {children}
  </a>
)
