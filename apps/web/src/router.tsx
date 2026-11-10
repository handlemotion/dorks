import { createHashHistory, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    // Hash routing: the built app is plain static files that the desktop shell or any static host serves from an arbitrary
    // path or custom scheme, with no server-side fallback to index.html.
    history: createHashHistory(),
    scrollRestoration: true,
    // The app scrolls inside the shell's main panel, not the window, and the layout keeps that element mounted across pages, so
    // reset it on navigation or the next page opens at the previous one's scroll offset.
    scrollToTopSelectors: ['.app-main'],
    defaultPreload: 'intent',
    // No route loaders (the client's stores own the data), so a preload only warms the code; never treat it as fresh data.
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
