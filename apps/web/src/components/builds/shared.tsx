import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildView, RunView } from '@dorks/client'
import { SettingsSections, StatusDot as Dot } from '../settings/kit'
import { runTone } from './format'

// The status dot and the facts strip are the settings kit's, shared with Automations.
export { StatusDot as Dot, SettingsFacts as Facts } from '../settings/kit'

// Small pieces shared by the Builds pages: status dots, tags, rows, the page column, the crumb and the facts strip.

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
