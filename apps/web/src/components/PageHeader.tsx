import type { ReactNode } from 'react'
import { ArchiveIcon, ArchiveRestoreIcon, ChevronRightIcon } from 'lucide-react'
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
 * The toolbar of a page in the app frame, one line (48px): the title (after its `parent` crumb on a nested page), then the page's actions,
 * with a bottom hairline aligned with the Chat details / Crew details tab bar. The sidebar toggle shows here only while the sidebar is hidden;
 * otherwise it lives in the sidebar's own header. `titleActions` sit right after the title.
 */
export function PageHeader({ title, parent, titleActions, actions }: { title: ReactNode; parent?: ReactNode; titleActions?: ReactNode; actions?: ReactNode }) {
  const { open, isMobile } = useSidebar()
  return (
    // While the sidebar is hidden, the floating title bar controls (AppFrame) sit over the header's start, so the title begins after them.
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border pr-3 pl-5" style={!open || isMobile ? { paddingLeft: TITLEBAR_CONTROLS_END } : undefined}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {parent && (
            <>
              <span className="shrink-0 text-muted-foreground">{parent}</span>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
          <h1 className="truncate text-sm font-normal!">{title}</h1>
        </div>
        {titleActions && <div className="-ml-1 flex shrink-0 items-center gap-0.5">{titleActions}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </header>
  )
}
