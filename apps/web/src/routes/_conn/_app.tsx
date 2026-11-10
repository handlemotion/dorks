import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '../../components/AppShell'
import { AppSidebar } from '../../components/AppSidebar'
import { setWindowMode } from '../../lib/desktop'

// Pathless layout for the pages that show the sidebar (/dorks, /settings); /onboarding is a focused page without it.
export const Route = createFileRoute('/_conn/_app')({ component: AppLayout })

function AppLayout() {
  // The desktop window shows its traffic lights only in the app, never during onboarding.
  useEffect(() => setWindowMode('app'), [])
  return <AppShell sidebar={<AppSidebar />}><Outlet /></AppShell>
}
