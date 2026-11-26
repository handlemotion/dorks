import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { createClient, type CloudOrg, type CloudPlaces, type CloudServer, type CloudStatus, type DorksClient, type QueryState, type Store } from '@dorks/client'
import { useStoreValue } from '@dorks/client/react'
import { remoteClientConfig, resolveTarget, usePlaceChoice, type Target } from '../lib/place'

/**
 * Dorks Cloud places (docs/mobile.md, "Desktop: Dorks Cloud"): the account's orgs, read from the home server (the one the app was
 * started against, which holds the cloud session), the org picked and the server it lands on. The app's client points at that server:
 * the home client itself, or another server through the home server's `/api/cloud/servers/:id`.
 */
export interface CloudPlace {
  /** The home server's client: the cloud account and its places live there, whatever server the app shows. */
  home: DorksClient
  cloud: CloudStatus | undefined
  places: CloudPlaces | undefined
  /** This server's id in the cloud (the phone link's), when paired: one of its org's Macs. */
  thisMacId: string | null
  /** The org in use; null when signed out (or the cloud is off): this Mac on its own. */
  org: CloudOrg | null
  personal: CloudOrg | null
  target: Target
  /** True until the picked org and its servers are known (no flash of the wrong server). */
  resolving: boolean
  chooseOrg(orgId: string | null): void
  /** A Mac inside the org; undefined for the org's default (this Mac when it may). */
  chooseMachine(machineId: string | undefined): void
}

const CTX = createContext<CloudPlace | null>(null)

/** The cloud place, or null outside the connection gate (design demos). */
export const useCloudPlace = () => useContext(CTX)

const IDLE: QueryState<CloudPlaces> = { status: 'ready', data: undefined, error: undefined }
const idle: Store<QueryState<CloudPlaces>> = { getSnapshot: () => IDLE, subscribe: () => () => {} }

/** How often the places are read again while signed in: a Mac comes online, a teammate adds a server. */
const PLACES_POLL_MS = 30_000

/** Resolves the place for `home` and hands its server's client to `children`. */
export function CloudPlaceProvider({ conn, children }: { conn: { serverUrl: string; token: string }; children: (client: DorksClient, place: CloudPlace) => ReactNode }) {
  const home = useMemo(() => createClient({ baseUrl: conn.serverUrl, token: conn.token }), [conn.serverUrl, conn.token])
  const cloudState = useStoreValue(home.cloud())
  const cloud = cloudState.data
  const signedIn = !!cloud?.user
  const placesState = useStoreValue(signedIn ? home.cloudPlaces() : idle)
  const thisMacId = useStoreValue(home.phone()).data?.macId ?? null
  const [choice, setChoice] = usePlaceChoice(conn.serverUrl)
  useEffect(() => {
    if (!signedIn) return
    const t = setInterval(() => document.visibilityState === 'visible' && home.refreshCloudPlaces(), PLACES_POLL_MS)
    return () => clearInterval(t)
  }, [home, signedIn])

  const orgs = placesState.data?.orgs
  const personal = orgs?.find((o) => o.personal) ?? null
  const org = signedIn && choice.orgId ? (orgs?.find((o) => o.id === choice.orgId) ?? null) : null
  // An older server has no /api/cloud: it answers an error, and the app stays on it.
  const resolving = !!choice.orgId && ((cloudState.status === 'loading' && !cloud) || (signedIn && !orgs && placesState.status === 'loading'))
  const target: Target = org ? resolveTarget(org, thisMacId, choice.machineId) : { kind: 'home' }
  const remoteId = target.kind === 'remote' ? target.server.id : null
  const client = useMemo(() => (remoteId ? createClient(remoteClientConfig(conn, remoteId)) : home), [home, remoteId, conn])

  const place: CloudPlace = {
    home,
    cloud,
    places: placesState.data,
    thisMacId,
    org,
    personal,
    target,
    resolving,
    chooseOrg: (orgId) => setChoice({ orgId: orgId ?? personal?.id ?? null }),
    chooseMachine: (machineId) => setChoice({ orgId: choice.orgId, machineId }),
  }
  return <CTX.Provider value={place}>{children(client, place)}</CTX.Provider>
}

/** An org's display name: the personal org is the account's own name ("Personal" when signed out or nameless). */
export const orgName = (org: CloudOrg | null, cloud: CloudStatus | undefined) => (!org || org.personal ? cloud?.user?.name || 'Personal' : org.name)

/** The server the app shows, when it is not this one. */
export const remoteServer = (place: CloudPlace | null): CloudServer | null => (place?.target.kind === 'remote' ? place.target.server : null)
