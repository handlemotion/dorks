import { useCanGoBack, useRouter } from '@tanstack/react-router'
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { SidebarTrigger } from '@dorks/ui/sidebar'
import { SIDEBAR_ICON_BUTTON } from './sidebarChrome'

/**
 * The title bar's controls: the sidebar toggle, then back and forward. AppFrame floats them over the window's top-left corner, right
 * after the macOS traffic lights (`--titlebar-inset-left` from the desktop shell, 0 in a browser), so they stay put whether the sidebar
 * is open or not.
 */
export function WindowControls() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <SidebarTrigger className={SIDEBAR_ICON_BUTTON} />
      <Button variant="ghost" size="icon-sm" className={SIDEBAR_ICON_BUTTON} aria-label="Back" title="Back" disabled={!canGoBack} onClick={() => router.history.back()}>
        <ArrowLeftIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" className={SIDEBAR_ICON_BUTTON} aria-label="Forward" title="Forward" onClick={() => router.history.forward()}>
        <ArrowRightIcon />
      </Button>
    </div>
  )
}

/** Left padding that clears the traffic lights, and never less than the sidebar's 6px inset. */
export const TITLEBAR_START = 'max(6px, var(--titlebar-inset-left, 0px))'

/** Where a page header's title starts while the sidebar is hidden: after the controls (three 30px buttons, 2px apart) and an 8px gap. */
export const TITLEBAR_CONTROLS_END = `calc(${TITLEBAR_START} + 94px + 8px)`
