import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router'

// Dev-only showcase of the sidebar with mock data: no sign-in or backend needed. In production the `import.meta.env.DEV` branch is
// compiled away, so the demo module is not bundled, and beforeLoad answers 404 for anyone who requests the URL anyway.
export const Route = createFileRoute('/dev/sidebar')({
  ssr: false,
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  validateSearch: (s: Record<string, unknown>): { dork?: string } => (typeof s.dork === 'string' ? { dork: s.dork } : {}),
  component: import.meta.env.DEV ? lazyRouteComponent(() => import('./-dev-sidebar-demo'), 'Demo') : undefined,
})
