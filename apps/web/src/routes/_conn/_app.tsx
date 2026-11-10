import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppFrame } from '../../components/AppFrame'
import { setWindowMode } from '../../lib/desktop'

// Pathless layout for the pages that show the sidebar (/dorks, /settings); /onboarding is a focused page without it.
export const Route = createFileRoute('/_conn/_app')({ component: AppLayout })

function AppLayout() {
  // The desktop window shows its traffic lights only in the app, never during onboarding.
  useEffect(() => setWindowMode('app'), [])
  return <AppFrame />
}
