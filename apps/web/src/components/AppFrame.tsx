import type { ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { SidebarInset, SidebarProvider } from '@dorks/ui/sidebar'
import { AppSidebar } from './AppSidebar'

/**
 * A floating glass sidebar beside a content panel, both on the window backdrop (native vibrancy in the desktop app, a soft
 * gradient in a browser). Pages render their own PageHeader and scroll inside the panel.
 */
export function FrameLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider className="app-backdrop h-svh min-h-0">
      {sidebar}
      <SidebarInset className="glass-content bg-glass-content! m-2 min-h-0 overflow-hidden rounded-3xl md:ml-0">
        {children}
      </SidebarInset>
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
