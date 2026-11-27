import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useStoreValue } from '@dorks/client/react'
import { isPaidOrg, runsOnWorker } from '../lib/place'
import { orgName, type CloudPlace } from './CloudPlace'

// A paid workspace (Dorks Teams or Dorks Cloud) runs in the cloud, never on a Mac (docs/move-to-cloud.md). One that this Mac still
// serves (a team paired before it paid, or the personal workspace that just upgraded) moves on its own the first time its owner or an
// admin opens it here: the sessions pause and upload with their chats, builds, automations and the rest, then the app follows it to the
// cloud. A move that fails (a session still working, the network) is not retried in a loop: Settings › Organization offers it again.

const tried = new Set<string>()
const admin = (role: string | null) => /\b(owner|admin)\b/.test(role ?? '')

export function AutoMove({ place }: { place: CloudPlace }) {
  const org = place.org
  const name = org ? orgName(org, place.cloud) : 'This workspace'
  const serverOrg = useStoreValue(place.home.me()).data?.serverOrg
  const status = useStoreValue(place.home.cloudMove()).data
  const shown = useRef<string | number | null>(null)
  const due = !!org && isPaidOrg(org) && !runsOnWorker(org) && serverOrg === org.id && admin(org.role) && place.target.kind === 'home'
  const mine = status?.orgId === org?.id ? status : undefined
  const running = !!mine && ['pausing', 'uploading', 'committing'].includes(mine.phase)

  useEffect(() => {
    if (!due || !org || !status || tried.has(org.id)) return
    if (mine && mine.phase !== 'idle') return // running, done, or failed once already: Settings shows it
    tried.add(org.id)
    void place.home.actions.cloudStartMove(org.id).catch((e: unknown) => {
      toast.error(`Couldn’t move ${name} to Dorks Cloud`, { description: e instanceof Error ? e.message : undefined })
    })
  }, [due, org, status, mine, place.home])

  // Progress is polled while it runs; at the end the places are read again, and the app follows the org to the cloud.
  useEffect(() => {
    if (!running) return
    shown.current ??= toast.loading(`Moving ${name} to Dorks Cloud…`, { description: 'Keep this Mac on until it finishes.', duration: Infinity })
    const t = setInterval(() => place.home.refreshCloudMove(), 1000)
    return () => clearInterval(t)
  }, [running, name, place.home])
  useEffect(() => {
    if (!mine || shown.current === null) return
    if (mine.phase === 'done') {
      toast.success(`${name} runs in Dorks Cloud now`, { id: shown.current, description: 'Sessions keep running when this Mac is off.', duration: 6000 })
      shown.current = null
      place.home.refreshCloudPlaces()
    } else if (mine.phase === 'failed') {
      toast.error(`Couldn’t move ${name} to Dorks Cloud`, { id: shown.current, description: mine.error ?? undefined, duration: 10000 })
      shown.current = null
    }
  }, [mine, name, place.home])
  return null
}
