import { createFileRoute, redirect } from '@tanstack/react-router'
import { useSettings } from '@dorks/client/react'
import { PageHeader } from '../../../components/PageHeader'
import { EmptyState } from '../../../components/EmptyState'
import { pageAccess, ReadOnly, useSettingsAccess } from '../../../components/settings/access'
import { findSettingsPage, isSettingsPage, lastSettingsPage, rememberSettingsPage } from '../../../components/settings/pages'

export const Route = createFileRoute('/_conn/settings/$page')({
  beforeLoad: ({ params }) => {
    if (!isSettingsPage(params.page)) throw redirect({ to: '/settings/$page', params: { page: lastSettingsPage() }, replace: true })
    rememberSettingsPage(params.page)
  },
  component: SettingsPage,
})

/** One settings page: the 48px header with its title, then its sections in a 640px column. */
function SettingsPage() {
  const { page } = Route.useParams()
  const settings = useSettings()
  const def = findSettingsPage(isSettingsPage(page) ? page : 'setup')
  // On another server (Dorks Cloud), what this page may do there: everything, look only, or nothing (access.tsx).
  const access = useSettingsAccess()
  const mode = pageAccess(def.remote, access)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={def.title} />
      <div className="app-main min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-160 px-4 pt-8 pb-16 sm:px-6">
          {settings ? (
            // Keyed by page so a page's unsaved inputs start from the stored values each time it opens.
            <div key={def.id}>
              {mode === 'hidden' ? (
                <EmptyState figure="plug" title={`Only on ${access.remote?.name ?? 'that computer'}`} description="This stays on the computer the server runs on." />
              ) : mode === 'view' && access.remote ? (
                <ReadOnly server={access.remote} admin={access.admin}>
                  {def.body(settings)}
                </ReadOnly>
              ) : (
                def.body(settings)
              )}
            </div>
          ) : (
            <p className="px-4 text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </div>
    </div>
  )
}
