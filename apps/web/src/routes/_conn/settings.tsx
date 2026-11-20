import { useEffect } from 'react'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { FrameLayout } from '../../components/AppFrame'
import { SettingsSidebar } from '../../components/settings/SettingsSidebar'
import { setWindowMode } from '../../lib/desktop'

// Settings, after Omni's: the app frame with the settings sidebar in place of the app's, and one page per section (/settings/<page>).
export const Route = createFileRoute('/_conn/settings')({ component: SettingsLayout })

function SettingsLayout() {
  useEffect(() => setWindowMode('app'), [])
  return (
    <FrameLayout sidebar={<SettingsSidebar />}>
      <Outlet />
    </FrameLayout>
  )
}
