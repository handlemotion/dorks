import type { ReactNode } from 'react'

export function Sidebar({ children }: { children: ReactNode }) {
  return <nav className="sidebar" aria-label="Sidebar">{children}</nav>
}

export function SidebarGroup({ children }: { children: ReactNode }) {
  return <div className="sidebar-group">{children}</div>
}
