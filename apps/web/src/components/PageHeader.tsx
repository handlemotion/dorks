import type { ReactNode } from 'react'
import { Separator } from '@dorks/ui/separator'
import { SidebarTrigger } from '@dorks/ui/sidebar'

/** The toolbar of a page in the app frame: sidebar toggle, title and subtitle, then the page's actions. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm leading-tight font-semibold">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}
