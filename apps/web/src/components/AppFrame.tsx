import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation } from '@tanstack/react-router'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { SidebarInset, SidebarProvider, useSidebar } from '@dorks/ui/sidebar'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { AppSidebar } from './AppSidebar'
import { SIDEBAR_WIDTH } from './sidebarChrome'
import { TITLEBAR_START, WindowControls } from './WindowControls'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'

/**
 * The app frame is flat and white (`bg-background`, #ffffff): the sidebar and the page share it, split by a full-height divider that is also
 * the resize handle (react-resizable-panels, through shadcn's Resizable). The sidebar's width is remembered; collapsing it (its
 * toggle, ⌘B, or dragging it shut) collapses the panel. On phones the sidebar is shadcn's sheet instead. Onboarding keeps the grey
 * app fill and is outside this frame.
 */
export function FrameLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider data-app-frame className="relative h-svh min-h-0 bg-background">
      <Panels sidebar={sidebar}>{children}</Panels>
      <Frame sidebar={sidebar} />
    </SidebarProvider>
  )
}

/** How long the pointer may be away from the toggle and the peeking sidebar before it slides away. */
const PEEK_LINGER = 200

/**
 * The frame's floating parts: the title bar controls and, while the sidebar is collapsed, its peek. Hovering the toggle slides the
 * sidebar in above the page (it fades in, nothing under it moves) so a page can be picked without opening it; it slides away when the
 * pointer leaves it, a row is picked, or Escape is pressed. Clicking the toggle still opens the sidebar for real.
 */
function Frame({ sidebar }: { sidebar: ReactNode }) {
  const { isMobile, open } = useSidebar()
  const enabled = !isMobile && !open
  const [peek, setPeek] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const cancel = useCallback(() => window.clearTimeout(timer.current), [])
  const show = useCallback(() => {
    cancel()
    if (enabled) setPeek(true)
  }, [cancel, enabled])
  const hide = useCallback(() => {
    cancel()
    timer.current = window.setTimeout(function close() {
      // A menu opened from the sidebar (the owner switcher, a row's context menu) lives in a portal outside it: stay until it closes.
      if (document.querySelector('[role="menu"]')) timer.current = window.setTimeout(close, PEEK_LINGER)
      else setPeek(false)
    }, PEEK_LINGER)
  }, [cancel])
  useEffect(() => cancel, [cancel])
  // Opening the sidebar for real, or moving to another page, ends the peek.
  const { pathname, searchStr } = useLocation()
  useEffect(() => {
    cancel()
    setPeek(false)
  }, [enabled, pathname, searchStr, cancel])
  useEffect(() => {
    if (!peek) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPeek(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peek])
  const shown = peek && enabled
  return (
    <>
      {/* Kept mounted (hidden) while the sidebar is collapsed, so it slides in and out. */}
      {enabled && (
        <div
          data-sidebar-peek
          data-state={shown ? 'open' : 'closed'}
          inert={!shown}
          onPointerEnter={show}
          onPointerLeave={hide}
          style={{ width: SIDEBAR_WIDTH }}
          className="absolute inset-y-0 left-0 z-10 flex border-r bg-background transition-[opacity,translate] duration-200 ease-out data-[state=closed]:pointer-events-none data-[state=closed]:-translate-x-4 data-[state=closed]:opacity-0 data-[state=closed]:duration-150 data-[state=closed]:ease-in motion-reduce:transition-none"
        >
          {sidebar}
        </div>
      )}
      {/* The title bar controls float over the frame's top-left corner, after the traffic lights, so opening or closing the sidebar never
          moves them; the sidebar's top bar and, while it is hidden, the page header leave room for them. */}
      <div className="pointer-events-none absolute top-0 left-0 z-20 flex h-12 items-center *:pointer-events-auto" style={{ paddingLeft: TITLEBAR_START }}>
        {/* Back and forward float here only while no sidebar shows them: an open or peeking sidebar has them in its own title bar. */}
        <WindowControls history={isMobile || (!open && !shown)} onToggleEnter={show} onToggleLeave={hide} />
      </div>
    </>
  )
}

function Panels({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const { isMobile, open, setOpen } = useSidebar()
  const panel = usePanelRef()
  const layout = useDefaultLayout({ id: 'dorks.frame.v3', storage: localStorage })
  // The sidebar's open state drives the panel; the panel reports back when it is dragged shut or open.
  useEffect(() => {
    const p = panel.current
    if (!p || p.isCollapsed() === !open) return
    if (open) p.expand()
    else p.collapse()
  }, [open, panel])
  if (isMobile) {
    return (
      <>
        {sidebar}
        <SidebarInset className="min-h-0 overflow-hidden bg-transparent">
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SidebarInset>
      </>
    )
  }
  return (
    <ResizablePanelGroup resizeTargetMinimumSize={{ fine: 24, coarse: 37 }} orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel
        id="sidebar"
        className="overflow-hidden"
        panelRef={panel}
        // 300px by default, and it keeps its width when the window resizes: the page takes the difference.
        defaultSize={SIDEBAR_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        minSize={200}
        maxSize={420}
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          const shown = size.inPixels > 0
          if (shown !== open) setOpen(shown)
        }}
      >
        {/* Only while open: collapsed, the peek (Frame) shows it instead. One instance at a time, so per-instance state (folded
            repositories, owner scope, chat order) is read fresh from storage by whichever one is shown. */}
        {open && sidebar}
      </ResizablePanel>
      {/* Drag to resize; a click snaps the sidebar back to its default width. */}
      <PanelResizeHandle aria-label="Resize sidebar" onReset={() => panel.current?.resize(SIDEBAR_WIDTH)} disabled={!open} className={!open ? 'hidden' : undefined} />
      <ResizablePanel id="main" minSize={480}>
        <SidebarInset className="h-full min-h-0 overflow-hidden bg-transparent">
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SidebarInset>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** The signed-in frame: the sidebar fed from the user's dorks, and the current page. */
export function AppFrame() {
  return (
    <FrameLayout sidebar={<AppSidebar />}>
      <Outlet />
    </FrameLayout>
  )
}
