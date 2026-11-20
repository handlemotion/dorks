import { createFileRoute, redirect } from '@tanstack/react-router'
import { lastSettingsPage } from '../../../components/settings/pages'

// /settings opens the page settings showed last (Setup the first time).
export const Route = createFileRoute('/_conn/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/$page', params: { page: lastSettingsPage() }, replace: true })
  },
})
