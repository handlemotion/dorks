import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router'

// Dev-only gallery of every AI Elements pattern cloned into @dorks/ui (packages/ui/src/components/ai-elements).
export const Route = createFileRoute('/dev/ai-elements')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  component: import.meta.env.DEV ? lazyRouteComponent(() => import('./-dev-ai-elements-demo'), 'Demo') : undefined,
})
