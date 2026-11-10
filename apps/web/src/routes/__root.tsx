import { Link, Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  // Without this the router logs a warning and renders a bare <p>Not Found</p>; also covers /dev/* in production.
  notFoundComponent: NotFound,
  component: Outlet,
})

function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <Link to="/dorks">Back to dorks</Link>
    </main>
  )
}
