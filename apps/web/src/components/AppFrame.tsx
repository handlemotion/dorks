import type { ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { SidebarInset, SidebarProvider } from '@dorks/ui/sidebar'
import { AppSidebar } from './AppSidebar'

/**
 * The app frame is flat: the sidebar and the page share one fill (`bg-app`) and a full-height divider separates them. Nothing floats
 * on it except a page's own raised surface (the chat's Chat details). Pages render their own PageHeader and scroll inside.
 */
export function FrameLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider className="h-svh min-h-0 bg-app">
      {sidebar}
      <SidebarInset className="min-h-0 overflow-hidden bg-transparent">{children}</SidebarInset>
    </SidebarProvider>
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
