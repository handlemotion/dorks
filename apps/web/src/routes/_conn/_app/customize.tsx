import { createFileRoute, redirect } from '@tanstack/react-router'

/** Legacy route kept as a redirect after Customize became Plugins. */
export const Route = createFileRoute('/_conn/_app/customize')({
  beforeLoad: ({ search }) => {
    const raw = search as Record<string, unknown>
    const tab = raw.tab === 'skills' ? 'skills' : 'plugins'
    throw redirect({ to: '/plugins', search: { tab }, replace: true })
  },
})
