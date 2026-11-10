import type { BoatCheck, DorksClient } from '@dorks/client'

/**
 * Boat refused the key; `status` says why (`needs_org`: the key belongs to several organizations, so one must be chosen). The
 * message is also under `data`, where `errorMessage` looks for words meant for the user (it never shows a plain Error's message).
 */
export class BoatCheckError extends Error {
  readonly data: { code: 'invalid'; message: string }
  constructor(readonly status: BoatCheck['status'], message: string) {
    super(message)
    this.data = { code: 'invalid', message }
  }
}

/**
 * Saves the Boat key and organization, but only after Boat has accepted them, so a wrong key is reported on the form that took it
 * instead of as a failed snapshot build later. Saving a new key also starts that build on the server when there is no snapshot yet.
 * Throws a `BoatCheckError` with the server's plain-words message when the check fails.
 */
export async function saveBoat(actions: DorksClient['actions'], key: string, org: string, savedOrg: string | null): Promise<void> {
  if (key === '' && org === (savedOrg ?? '')) return
  const check = await actions.checkBoat({ ...(key ? { boatKey: key } : {}), boatOrg: org })
  if (check.status !== 'ok') throw new BoatCheckError(check.status, check.message)
  await actions.updateSettings({ ...(key ? { boatKey: key } : {}), boatOrg: org })
}
