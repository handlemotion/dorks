import { useCanGoBack, useRouter } from '@tanstack/react-router'
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { SidebarTrigger } from '@dorks/ui/sidebar'
import { SIDEBAR_ICON_BUTTON } from './sidebarChrome'
import { Tip } from './Tip'

/**
 * The title bar's floating controls: the sidebar toggle, and back and forward while the sidebar is hidden (shown, the sidebar's own
 * title bar carries them at its right end, after the workspace switcher). AppFrame floats them over the window's top-left corner, right
 * after the macOS traffic lights (`--titlebar-inset-left` from the desktop shell, 0 in a browser), so the toggle stays put whether the
 * sidebar is open or not. Hovering the toggle while the sidebar is collapsed peeks it.
 */
export function WindowControls({ history, onToggleEnter, onToggleLeave }: { history: boolean; onToggleEnter?: () => void; onToggleLeave?: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* While the sidebar is collapsed, hovering the toggle peeks it (AppFrame). */}
      <SidebarTrigger className={SIDEBAR_ICON_BUTTON} onPointerEnter={onToggleEnter} onPointerLeave={onToggleLeave} />
      {history && <HistoryButtons />}
    </div>
  )
}

/** Back and forward. */
export function HistoryButtons() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tip label="Back">
        <Button variant="ghost" size="icon-sm" className={SIDEBAR_ICON_BUTTON} aria-label="Back" disabled={!canGoBack} onClick={() => router.history.back()}>
          <ArrowLeftIcon />
        </Button>
      </Tip>
      <Tip label="Forward">
        <Button variant="ghost" size="icon-sm" className={SIDEBAR_ICON_BUTTON} aria-label="Forward" onClick={() => router.history.forward()}>
          <ArrowRightIcon />
        </Button>
      </Tip>
    </div>
  )
}

/** Left padding that clears the traffic lights, and never less than the sidebar's 6px inset. */
export const TITLEBAR_START = 'max(6px, var(--titlebar-inset-left, 0px))'

/** Where the sidebar's title bar starts its own controls: after the floating toggle (28px) and the controls' 2px gap. */
export const TITLEBAR_AFTER_TOGGLE = `calc(${TITLEBAR_START} + 28px + 2px)`

/** Where a page header's title starts while the sidebar is hidden: after the controls (three 28px buttons, 2px apart) and an 8px gap. */
export const TITLEBAR_CONTROLS_END = `calc(${TITLEBAR_START} + 88px + 8px)`
