import type { ComponentProps, ComponentType, ReactNode } from 'react'
import { cn } from 'cn'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@dorks/ui/select'

/**
 * The settings kit, after Omni's: a page is a stack of titled sections, a section holds one or more groups, and a group is a column of
 * rows (label and description on the left, the control on the right). A group is the one raised surface on the page: `--surface` with
 * the `--surface-line` hairline in light (white on the off-white frame is under 1.15:1), rows split by full 6% hairlines.
 */

export type SettingsIcon = ComponentType<{ className?: string }>

/** The page's stack of sections, 32px apart. */
export function SettingsSections({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8">{children}</div>
}

/** A titled set of groups. The title is a muted label, inset to the rows' text, with an optional one-line description. */
export function SettingsSection({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn('flex min-w-0 flex-col', description ? 'gap-3' : 'gap-2')}>
      <div className="flex min-h-7 items-center justify-between gap-3 px-4">
        <div className="min-w-0">
          <h2 className="text-sm text-muted-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">{children}</div>
    </section>
  )
}

const GROUP = '@container flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-surface dark:border-transparent'

/** A raised column of rows. Pass `onSubmit` to make it a form (its Save button lives in a `SettingsGroupFooter`). */
export function SettingsGroup({ children, className, onSubmit, label }: { children: ReactNode; className?: string; onSubmit?: () => void; label?: string }) {
  if (onSubmit)
    return (
      <form
        aria-label={label}
        className={cn(GROUP, className)}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        {children}
      </form>
    )
  return (
    <div aria-label={label} className={cn(GROUP, className)}>
      {children}
    </div>
  )
}

/** Free content inside a group: an explanation, a progress bar, a list. Small and muted unless it says otherwise. */
export function SettingsGroupBody({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col gap-2 px-4 py-3 text-xs text-pretty text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4', className)} {...props}>
      {children}
    </div>
  )
}

/** A group's last row when its rows are saved together: what saving does on the left, the button on the right. */
export function SettingsGroupFooter({ children, action }: { children?: ReactNode; action: ReactNode }) {
  return (
    <div className="flex min-h-13 flex-col items-stretch gap-3 bg-app/40 py-2.5 ps-4 pe-3 @md:flex-row @md:items-center @md:justify-between @md:gap-4">
      <div className="min-w-0 text-xs text-pretty text-muted-foreground">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  )
}

// Narrower than 448px (a phone), the control drops under the text and takes the row's width.
const ROW = 'flex min-h-13 w-full min-w-0 flex-col items-stretch gap-3 py-2.5 ps-4 pe-3 text-start @md:flex-row @md:items-center @md:gap-4'

/** A row's icon, label and description. */
function RowText({ icon: Icon, label, description, htmlFor }: { icon?: SettingsIcon; label: ReactNode; description?: ReactNode; htmlFor?: string }) {
  const title = <span className="block min-w-0 truncate text-sm leading-4 text-foreground">{label}</span>
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {Icon && (
        <span className="-ms-1.5 flex size-8 shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}
        {description && <div className="text-xs leading-4 text-pretty text-muted-foreground">{description}</div>}
      </div>
    </div>
  )
}

export type SettingsRowProps = { icon?: SettingsIcon; label: ReactNode; description?: ReactNode; htmlFor?: string; className?: string; control?: ReactNode }

/** The generic row: text on the left, any control on the right. Use the typed rows below when one fits. */
export function SettingsRow({ control, className, ...text }: SettingsRowProps) {
  return (
    <div data-slot="settings-row" className={cn(ROW, className)}>
      <RowText {...text} />
      {control && <div className="flex min-w-0 shrink-0 items-center gap-2 @md:justify-end">{control}</div>}
    </div>
  )
}

/** Every settings input is this one size: as tall as the small buttons and selects beside it. */
export const SETTINGS_INPUT = 'h-8 min-w-0 flex-1 @md:w-56 @md:flex-none'

/** A short text value edited in place; `trailing` is the button that commits it, if the row saves on its own. */
export function SettingsInputRow({
  id,
  icon,
  label,
  description,
  trailing,
  inputClassName,
  ...input
}: Omit<ComponentProps<'input'>, 'id' | 'className'> & { id: string; icon?: SettingsIcon; label: ReactNode; description?: ReactNode; trailing?: ReactNode; inputClassName?: string }) {
  return (
    <SettingsRow
      icon={icon}
      label={label}
      description={description}
      htmlFor={id}
      control={
        <>
          <Input id={id} className={cn(SETTINGS_INPUT, inputClassName)} {...input} />
          {trailing}
        </>
      }
    />
  )
}

/** How a value reads: data, a state (Not set), a failure, or done. */
export const SETTINGS_TONE = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  danger: 'text-destructive',
  success: 'text-emerald-600 dark:text-emerald-400',
} as const

/** A read-only fact: a login, a status, a count. `tone` colours states (Not set, Failed) rather than data. */
export function SettingsValueRow({
  value,
  mono,
  tone = 'default',
  valueTestId,
  ...text
}: Omit<SettingsRowProps, 'control'> & { value: ReactNode; mono?: boolean; tone?: keyof typeof SETTINGS_TONE; valueTestId?: string }) {
  return (
    <SettingsRow
      {...text}
      className="pe-4"
      control={
        <span data-testid={valueTestId} className={cn('max-w-64 truncate text-sm tabular-nums', mono && 'font-mono text-xs', SETTINGS_TONE[tone])}>
          {value}
        </span>
      }
    />
  )
}

/** A row whose control is one action. */
export function SettingsButtonRow({
  actionLabel,
  onAction,
  disabled,
  variant = 'outline',
  ...text
}: Omit<SettingsRowProps, 'control'> & { actionLabel: string; onAction: () => void; disabled?: boolean; variant?: 'outline' | 'default' | 'destructive' }) {
  return (
    <SettingsRow
      {...text}
      control={
        <Button type="button" size="sm" variant={variant} disabled={disabled} onClick={onAction}>
          {actionLabel}
        </Button>
      }
    />
  )
}

export interface SettingsOption<V extends string> {
  value: V
  label: string
}

/** One choice from a short list: a select as wide as its choice, never wider than an input. */
export function SettingsSelectRow<V extends string>({
  label,
  value,
  options,
  onValueChange,
  ...text
}: Omit<SettingsRowProps, 'control' | 'label'> & { label: string; value: V; options: readonly SettingsOption<V>[]; onValueChange: (value: V) => void }) {
  return (
    <SettingsRow
      {...text}
      label={label}
      control={
        <Select items={options} value={value} onValueChange={(next) => next !== null && onValueChange(next as V)}>
          <SelectTrigger size="sm" aria-label={label} className="w-auto max-w-56 min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}

/** The outcome of a save, under a group: `Saved.` or the error. */
export function SettingsStatus({ saved, error }: { saved?: boolean; error?: string }) {
  if (error)
    return (
      <p role="alert" className="px-4 text-xs text-destructive">
        {error}
      </p>
    )
  if (saved)
    return (
      <p role="status" className="px-4 text-xs text-muted-foreground">
        Saved.
      </p>
    )
  return null
}

/** Where something stands, for a status dot and its words. */
export type Tone = 'success' | 'running' | 'warning' | 'danger' | 'idle'

/** The words beside a status dot. Success and running read as plain text: the dot says it. */
export const TONE_TEXT: Record<Tone, string> = {
  success: '',
  running: '',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
  idle: 'text-muted-foreground',
}

/** A status dot: filled for a state, a ring for nothing yet. */
export function StatusDot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'success' && 'bg-emerald-600 dark:bg-emerald-400',
        tone === 'running' && 'bg-brand',
        tone === 'warning' && 'bg-amber-600 dark:bg-amber-400',
        tone === 'danger' && 'bg-destructive',
        tone === 'idle' && 'border-[1.5px] border-muted-foreground/60',
      )}
    />
  )
}

/** A strip of facts across the top of a group: label over value, split by full hairlines. Four across, two on narrow windows. */
export function SettingsFacts({ items }: { items: { label: string; value: ReactNode; testId?: string }[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4">
      {items.map((f) => (
        <div
          key={f.label}
          className="flex min-w-0 flex-col gap-1.5 border-e border-b px-4 py-3.5 text-sm [&:nth-child(2n)]:border-e-0 md:border-b-0 md:[&:nth-child(2n)]:border-e md:[&:nth-child(4n)]:border-e-0"
        >
          <span className="text-xs text-muted-foreground">{f.label}</span>
          <span data-testid={f.testId} className="flex min-w-0 items-center gap-2 truncate tabular-nums">
            {f.value}
          </span>
        </div>
      ))}
    </div>
  )
}
