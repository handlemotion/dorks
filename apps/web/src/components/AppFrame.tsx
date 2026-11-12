import { useEffect, type ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { SidebarInset, SidebarProvider, useSidebar } from '@dorks/ui/sidebar'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { AppSidebar } from './AppSidebar'
import { TITLEBAR_START, WindowControls } from './WindowControls'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'

const SIDEBAR_WIDTH = 275

/**
 * The app frame is flat and off white (`bg-background`, #fafafa): the sidebar and the page share it, split by a full-height divider that is also
 * the resize handle (react-resizable-panels, through shadcn's Resizable). The sidebar's width is remembered; collapsing it (its
 * toggle, ⌘B, or dragging it shut) collapses the panel. On phones the sidebar is shadcn's sheet instead. Onboarding keeps the grey
 * app fill and is outside this frame.
 */
export function FrameLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider data-app-frame className="relative h-svh min-h-0 bg-background">
      <Panels sidebar={sidebar}>{children}</Panels>
      {/* The title bar controls float over the frame's top-left corner, after the traffic lights, so opening or closing the sidebar never
          moves them; the sidebar's top bar and, while it is hidden, the page header leave room for them. */}
      <div className="pointer-events-none absolute top-0 left-0 z-20 flex h-12 items-center *:pointer-events-auto" style={{ paddingLeft: TITLEBAR_START }}>
        <WindowControls />
      </div>
    </SidebarProvider>
  )
}

function Panels({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const { isMobile, open, setOpen } = useSidebar()
  const panel = usePanelRef()
  const layout = useDefaultLayout({ id: 'dorks.frame.v2', storage: localStorage })
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
        // 275px by default, and it keeps its width when the window resizes: the page takes the difference.
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
        {sidebar}
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
