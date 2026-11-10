import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AppShell } from '../../components/AppShell'
import { AppSidebar } from '../../components/AppSidebar'

// Pathless layout for the pages that show the sidebar (/dorks, /settings); /setup is a focused page without it.
export const Route = createFileRoute('/_conn/_app')({
  component: () => <AppShell sidebar={<AppSidebar />}><Outlet /></AppShell>,
})
