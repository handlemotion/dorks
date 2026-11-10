import type { DorksClient } from '@dorks/client'

/**
 * Saves the Boat key and organization, but only after Boat has accepted them, so a wrong key is reported on the form that took it
 * instead of as a failed "Prepare Boat" a step later. Throws with the server's plain-words message when the check fails.
 */
export async function saveBoat(actions: DorksClient['actions'], key: string, org: string, savedOrg: string | null): Promise<void> {
  if (key === '' && org === (savedOrg ?? '')) return
  const check = await actions.checkBoat({ ...(key ? { boatKey: key } : {}), boatOrg: org })
  if (check.status !== 'ok') throw new Error(check.message)
  await actions.updateSettings({ ...(key ? { boatKey: key } : {}), boatOrg: org })
}
