import { createFileRoute, Outlet } from '@tanstack/react-router'
import { ConnectionGate } from '../components/ConnectionGate'

// Pathless layout shared by every page that talks to the server, so the client and its live stream mount once and survive
// navigation between /setup, /dorks and /settings. The dev demos live outside it and need no server.
export const Route = createFileRoute('/_conn')({
  component: () => (
    <ConnectionGate>
      <Outlet />
    </ConnectionGate>
  ),
})
