import { useEffect, type ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { SidebarInset, SidebarProvider, useSidebar } from '@dorks/ui/sidebar'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { AppSidebar } from './AppSidebar'

/**
 * The app frame is flat and white (`bg-background`): the sidebar and the page share it, split by a full-height divider that is also
 * the resize handle (react-resizable-panels, through shadcn's Resizable). The sidebar's width is remembered; collapsing it (its
 * toggle, ⌘B, or dragging it shut) collapses the panel. On phones the sidebar is shadcn's sheet instead. Onboarding keeps the grey
 * app fill and is outside this frame.
 */
export function FrameLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider data-app-frame className="h-svh min-h-0 bg-background">
      <Panels sidebar={sidebar}>{children}</Panels>
    </SidebarProvider>
  )
}

function Panels({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const { isMobile, open, setOpen } = useSidebar()
  const panel = usePanelRef()
  const layout = useDefaultLayout({ id: 'dorks.frame', storage: localStorage })
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
        <SidebarInset className="min-h-0 overflow-hidden bg-transparent">{children}</SidebarInset>
      </>
    )
  }
  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel
        id="sidebar"
        className="overflow-hidden"
        panelRef={panel}
        defaultSize={256}
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
      <ResizableHandle />
      <ResizablePanel id="main" minSize={480}>
        <SidebarInset className="h-full min-h-0 overflow-hidden bg-transparent">{children}</SidebarInset>
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
