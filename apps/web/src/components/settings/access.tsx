import type { ReactNode } from 'react'
import type { CloudServer } from '@dorks/client'
import { useMe } from '@dorks/client/react'
import { remoteServer, useCloudPlace } from '../CloudPlace'

/**
 * What a settings page is on another server reached through Dorks Cloud (docs/cloud.md, "Roles"):
 * - `local`: about this app or this account, never the server's (Appearance, Dorks Cloud): always as here;
 * - `edit`: settings the server lets an admin or owner change over the relay; a member sees them read-only;
 * - `view`: shown, never changed from afar (the setup checklist, the snapshot build);
 * - `hidden`: what never crosses the relay (sign-ins, local access, phone pairing): not shown at all.
 */
export type RemotePolicy = 'local' | 'edit' | 'view' | 'hidden'

export type PageAccess = 'full' | 'view' | 'hidden'

export interface SettingsAccess {
  /** The server the app shows, when it is not this one. */
  remote: CloudServer | null
  /** An admin or owner of the org that owns it (`GET /api/me` through the relay). */
  admin: boolean
}

/** Better Auth may send a comma list of roles; the strongest counts. */
export const isAdminRole = (role: string | null | undefined) => !!role && role.split(',').some((r) => r.trim() === 'owner' || r.trim() === 'admin')

export function useSettingsAccess(): SettingsAccess {
  const remote = remoteServer(useCloudPlace())
  const me = useMe()
  return { remote, admin: !remote || isAdminRole(me?.role) }
}

export function pageAccess(policy: RemotePolicy, access: SettingsAccess): PageAccess {
  if (!access.remote || policy === 'local') return 'full'
  if (policy === 'hidden') return 'hidden'
  return policy === 'edit' && access.admin ? 'full' : 'view'
}

/**
 * A page shown read-only: one line saying why, then its controls, disabled by the fieldset (native inputs and buttons) and inert (the
 * rest, such as base-ui's switches and selects, which a fieldset does not reach).
 */
export function ReadOnly({ server, admin, children }: { server: CloudServer; admin: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="px-4 text-xs text-muted-foreground">
        {admin ? `Shown as ${server.name} has it. Change it on that computer.` : `View only. Admins of the organization can change these on ${server.name}.`}
      </p>
      <fieldset disabled inert className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </div>
  )
}
