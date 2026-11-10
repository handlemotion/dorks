import type { ReactNode } from 'react'
import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { useSidebar } from '@dorks/ui/sidebar'
import { BAR_BUTTON } from './PreviewBrowser'
import { TITLEBAR_CONTROLS_END } from './WindowControls'
import { Tip } from './Tip'

/** Archive (or restore) a chat: an icon button beside its title. */
export function ArchiveButton({ archived, disabled, onClick }: { archived?: boolean; disabled?: boolean; onClick: () => void }) {
  const label = archived ? 'Unarchive' : 'Archive'
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label={label} disabled={disabled} onClick={onClick}>
        {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
      </Button>
    </Tip>
  )
}

/**
 * The toolbar of a page in the app frame, one line: title and subtitle, then the page's actions, over a full-width divider (unless the
 * page turns it off). The sidebar toggle shows here only while the sidebar is hidden; otherwise it lives in the sidebar's own header.
 * `titleActions` sit right after the title.
 */
export function PageHeader({ title, subtitle, titleActions, actions, divider = true }: {
  title: ReactNode
  subtitle?: ReactNode
  titleActions?: ReactNode
  actions?: ReactNode
  /** Off on chats, which run straight into the transcript. */
  divider?: boolean
}) {
  const { open, isMobile } = useSidebar()
  return (
    // While the sidebar is hidden, the floating title bar controls (AppFrame) sit over the header's start, so the title begins after them.
    <header data-tauri-drag-region className={`flex h-12 shrink-0 items-center gap-0.5 px-5 ${divider ? 'border-b' : ''}`} style={!open || isMobile ? { paddingLeft: TITLEBAR_CONTROLS_END } : undefined}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-sm font-normal!">{title}</h1>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {titleActions && <div className="-ml-1 flex shrink-0 items-center gap-0.5">{titleActions}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </header>
  )
}
