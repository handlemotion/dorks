import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // The app scrolls inside the shell's main panel, not the window, and the layout keeps that element mounted across pages, so
    // reset it on navigation or the next page opens at the previous one's scroll offset.
    scrollToTopSelectors: ['.app-main'],
    defaultPreload: 'intent',
    // No route loaders (Convex subscriptions own the data), so a preload only warms the code; never treat it as fresh data.
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
