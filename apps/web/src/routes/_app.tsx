import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AuthShell } from '../components/AuthShell'

// Pathless layout (no URL segment) shared by every signed-in page, so the Convex/auth provider and the sidebar mount once and
// survive navigation between /dorks, /settings and /github/callback. Client-only because the Convex client needs a browser;
// children inherit `ssr: false`.
export const Route = createFileRoute('/_app')({
  ssr: false,
  component: () => <AuthShell><Outlet /></AuthShell>,
})
