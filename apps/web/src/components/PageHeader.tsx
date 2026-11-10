import type { ReactNode } from 'react'
import { SidebarTrigger, useSidebar } from '@dorks/ui/sidebar'

/**
 * The toolbar of a page in the app frame: title and subtitle, then the page's actions, over a full-width divider (unless the page turns it off). The sidebar toggle
 * shows here only while the sidebar is hidden; otherwise it lives in the sidebar's own header.
 */
export function PageHeader({ title, subtitle, actions, divider = true }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; /** Off beside Chat details, where a line would stop short of the panel. */ divider?: boolean }) {
  const { open, isMobile } = useSidebar()
  return (
    <header data-tauri-drag-region className={`flex h-12 shrink-0 items-center gap-2 px-4 ${divider ? 'border-b' : ''}`}>
      {(!open || isMobile) && <SidebarTrigger className="-ml-1.5 text-muted-foreground" />}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-sm">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </header>
  )
}
