import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router'

export const Route = createFileRoute('/dev/chat')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  validateSearch: (s: Record<string, unknown>): { dork?: string } => (typeof s.dork === 'string' ? { dork: s.dork } : {}),
  component: import.meta.env.DEV ? lazyRouteComponent(() => import('./-dev-chat-demo'), 'Demo') : undefined,
})
