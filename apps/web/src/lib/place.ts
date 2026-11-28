import { useSyncExternalStore } from 'react'
import type { CloudOrg, CloudServer } from '@dorks/client'

/**
 * Where the app works (docs/mobile.md, "Desktop: Dorks Cloud"): an organization, and inside it, when it has no hosted server, the Mac
 * it runs on. The switcher picks the org; the server behind it is resolved here, never listed in the switcher:
 *
 * - an org with a hosted server: that server, through the relay;
 * - a Teams org with no Mac in it: the org runtime (the dorks-cloud Worker), its live updates read from s2;
 * - the personal org (or a team this Mac belongs to): this Mac, the local server, unless another of its Macs was picked inside it;
 * - a team with one Mac and no hosted server: that Mac, through the relay;
 * - otherwise (several Macs, or none): the org asks which to connect to.
 */
export type Target = { kind: 'home' } | { kind: 'cloud'; org: CloudOrg } | { kind: 'remote'; server: CloudServer } | { kind: 'choose'; machines: CloudServer[]; home: boolean }

/** What the owner picked, remembered per home server: `orgId` null is this Mac with no cloud org (signed out). */
export interface PlaceChoice {
  orgId: string | null
  /** A Mac picked inside the org; `home` for this one. */
  machineId?: string
}

/** The server an org's choice lands on. Pure; `thisMacId` is this server's id in the cloud (the phone link's), if paired. */
export function resolveTarget(org: CloudOrg, thisMacId: string | null, machineId?: string): Target {
  const hosted = org.servers.find((s) => s.kind === 'hosted')
  if (hosted) return { kind: 'remote', server: hosted }
  if (runsOnWorker(org)) return { kind: 'cloud', org }
  const machines = org.servers.filter((s) => s.kind === 'mac' && s.id !== thisMacId)
  const home = org.personal || (!!thisMacId && org.servers.some((s) => s.id === thisMacId))
  const picked = machines.find((m) => m.id === machineId)
  if (picked) return { kind: 'remote', server: picked }
  if (home) return { kind: 'home' }
  if (machines.length === 1 && machines[0]!.online) return { kind: 'remote', server: machines[0]! }
  return { kind: 'choose', machines, home }
}

export const isPaidOrg = (org: CloudOrg) => org.plan === 'teams'

/**
 * A paid org (Dorks Teams, the personal workspace included) runs on the Worker (its `orgRuntime`), never on a Mac. The relay says
 * where it runs now (`runtime`): `cloud` once it moved (a personal workspace keeps its Mac in it) or when it never had a Mac; `mac`
 * while a Mac still serves it, until its move (AutoMove.tsx starts it). An older relay sends no `runtime`: a team with no Mac then.
 * Dorks Local (free) stays on this Mac.
 */
export const runsOnWorker = (org: CloudOrg) => isPaidOrg(org) && (org.runtime ? org.runtime === 'cloud' : !org.personal && !org.servers.some((s) => s.kind === 'mac'))

/** The Macs an org can switch between inside it (this one first when it may), for the sidebar's Connect to menu. */
export function machinesOf(org: CloudOrg, thisMacId: string | null): { home: boolean; machines: CloudServer[] } {
  if (org.servers.some((s) => s.kind === 'hosted')) return { home: false, machines: [] }
  return { home: org.personal || (!!thisMacId && org.servers.some((s) => s.id === thisMacId)), machines: org.servers.filter((s) => s.kind === 'mac' && s.id !== thisMacId) }
}

const KEY = 'dorks.place'
const listeners = new Set<() => void>()
const NONE: PlaceChoice = { orgId: null }

function read(home: string): PlaceChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as (PlaceChoice & { home?: string }) | null
    return v && v.home === home ? { orgId: v.orgId ?? null, machineId: v.machineId } : NONE
  } catch {
    return NONE
  }
}

let cache: { home: string; raw: string | null; value: PlaceChoice } | undefined

function snapshot(home: string): PlaceChoice {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // Nothing remembered.
  }
  if (!cache || cache.home !== home || cache.raw !== raw) cache = { home, raw, value: read(home) }
  return cache.value
}

export function savePlace(home: string, choice: PlaceChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ home, ...choice }))
  } catch {
    // Not remembered; it still applies until the page reloads.
    cache = { home, raw: null, value: choice }
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The place picked for the home server at `home`, and a setter. */
export function usePlaceChoice(home: string): [PlaceChoice, (c: PlaceChoice) => void] {
  const choice = useSyncExternalStore(subscribe, () => snapshot(home))
  return [choice, (c) => savePlace(home, c)]
}

/** The UI API of another server, through the home server's `/api/cloud/servers/:id` (which adds the Dorks Cloud session). */
export function remoteClientConfig(home: { serverUrl: string; token: string }, serverId: string) {
  const id = encodeURIComponent(serverId)
  return { baseUrl: `${home.serverUrl}/api/cloud/servers/${id}`, token: home.token, imageBaseUrl: `${home.serverUrl}/cloud/servers/${id}` }
}

/** A Worker-run org's UI API and its realtime routes (read tokens for s2), through the home server's `/api/cloud/orgs/:id`. */
export function cloudOrgClientConfig(home: { serverUrl: string; token: string }, org: Pick<CloudOrg, 'id' | 'personal'>) {
  const base = `${home.serverUrl}/api/cloud/orgs/${encodeURIComponent(org.id)}`
  // Presence is a team's: a personal org has nobody else to show.
  return {
    baseUrl: base,
    token: home.token,
    // Shared images load in plain <img> tags (no owner token): through the home server's public `/cloud/orgs/:id/images/:image`.
    imageBaseUrl: `${home.serverUrl}/cloud/orgs/${encodeURIComponent(org.id)}`,
    cloud: { realtimeUrl: `${base}/realtime`, presence: !org.personal },
  }
}
