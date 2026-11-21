import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildView, RunView } from '@dorks/client'
import { SettingsSections } from '../settings/kit'
import { type Tone, runTone } from './format'

// Small pieces shared by the Builds pages: status dots, tags, rows, the page column, the crumb and the facts strip.

export function Dot({ tone }: { tone: Tone }) {
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

export function Tag({ children, tone }: { children: ReactNode; tone?: 'added' | 'removed' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-px text-xs',
        tone === 'added' ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400' : tone === 'removed' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/[0.05] text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

export const ROW = 'flex min-h-13 w-full min-w-0 items-center gap-3 py-2.5 ps-4 pe-3 text-start text-sm'
export const LINK_ROW = `${ROW} hover:bg-foreground/[0.025]`
export const Chevron = () => <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />

/** Two lines: a title and a muted description, filling the row. */
export function RowText({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate leading-4">{title}</span>
      {description && <span className="truncate text-xs leading-4 text-muted-foreground">{description}</span>}
    </div>
  )
}

/** The page body: the settings column. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 sm:px-6">
        <SettingsSections>{children}</SettingsSections>
      </div>
    </div>
  )
}

export const BuildCrumb = ({ build }: { build?: BuildView }) =>
  build ? (
    <Link to="/builds" search={{ build: build.id }} className="hover:text-foreground">
      {build.name}
    </Link>
  ) : (
    <Link to="/builds" className="hover:text-foreground">
      Builds
    </Link>
  )

/** A strip of facts across the top of a page: label over value, split by full hairlines. */
export function Facts({ items }: { items: { label: string; value: ReactNode; testId?: string }[] }) {
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

export function RunIcon({ r }: { r: RunView }) {
  const tone = runTone(r)
  if (tone === 'success') return <CheckIcon aria-label="Succeeded" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  if (tone === 'danger') return <XIcon aria-label="Failed" className="size-3.5 shrink-0 text-destructive" />
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <Dot tone={tone} />
    </span>
  )
}
