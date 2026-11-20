import { Link, useCanGoBack, useLocation, useRouter } from '@tanstack/react-router'
import { ChevronLeftIcon } from 'lucide-react'
import { FluidHoverHighlight } from '@dorks/ui/fluid-hover-highlight'
import { Sidebar, useSidebar } from '@dorks/ui/sidebar'
import { SIDEBAR_ROW, SIDEBAR_SECTION } from '../sidebarChrome'
import { useRowHover } from '../useRowHover'
import { PERSONAL_PAGES, SETUP_PAGE, organizationPages, type SettingsPageDef } from './pages'

/**
 * The sidebar while in settings, after Omni's: it takes the app sidebar's place with the same chrome (48px title bar, 30px rows under
 * one springing hover fill), Back to app at the top, Setup, then the pages under Personal and Organization. Moving between settings
 * pages replaces the history entry, so Back to app (and the title bar's Back) returns to where the app was.
 */
export function SettingsSidebar() {
  const { isMobile } = useSidebar()
  const hover = useRowHover()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return (
    <Sidebar collapsible={isMobile ? 'offcanvas' : 'none'} className={isMobile ? undefined : 'h-full w-full'}>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-foreground">
        <div data-tauri-drag-region className="h-12 shrink-0" />
        <div ref={hover.containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1.5 pt-1 pb-1.5">
          <FluidHoverHighlight className="z-0 rounded-[6px] bg-foreground/[0.05]" rect={hover.rect} session={hover.session} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain">
            <nav aria-label="Settings" className="flex shrink-0 flex-col gap-0.5">
              <Link
                to="/dorks"
                search={{}}
                className={SIDEBAR_ROW}
                onClick={(e) => {
                  if (!canGoBack) return
                  e.preventDefault()
                  router.history.back()
                }}
              >
                <ChevronLeftIcon />
                Back to app
              </Link>
              <PageLink page={SETUP_PAGE} />
            </nav>
            <Group label="Personal" pages={PERSONAL_PAGES} />
            <Group label="Organization" pages={organizationPages()} />
          </div>
        </div>
      </div>
    </Sidebar>
  )
}

function Group({ label, pages }: { label: string; pages: SettingsPageDef[] }) {
  return (
    <nav aria-label={label} className="flex shrink-0 flex-col gap-0.5">
      <div className={SIDEBAR_SECTION}>{label}</div>
      {pages.map((p) => (
        <PageLink key={p.id} page={p} />
      ))}
    </nav>
  )
}

function PageLink({ page }: { page: SettingsPageDef }) {
  const { pathname } = useLocation()
  const active = pathname === `/settings/${page.id}`
  return (
    <Link to="/settings/$page" params={{ page: page.id }} replace data-active={active || undefined} aria-current={active ? 'page' : undefined} className={SIDEBAR_ROW}>
      {page.icon}
      <span className="min-w-0 truncate">{page.title}</span>
    </Link>
  )
}
