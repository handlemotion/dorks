import type { DorkState } from '@dorks/shared'
import { useDorks } from '@dorks/convex/client'
import { ChatSidebar, type Chat } from './ChatSidebar'

const PR_NUMBER = /\/pull\/(\d+)/

/** Pull request number from the stored PR url. The backend does not keep the number or merged/closed state yet. */
function prOf(prUrl: string | undefined): Chat['pr'] {
  const n = prUrl && PR_NUMBER.exec(prUrl)?.[1]
  return n ? { number: Number(n) } : undefined
}

/** Dork states in which something is moving. Everything else (idle, sleeping, error) is shown as still. */
const MOVING: ReadonlySet<DorkState> = new Set(['creating', 'working', 'waking'])

/** The signed-in app's sidebar, fed from the user's dorks. */
export function AppSidebar() {
  const dorks = useDorks(false)
  const chats: Chat[] = (dorks ?? []).map((d) => ({ id: d._id, title: d.title, working: MOVING.has(d.state), pr: prOf(d.prUrl) }))
  return <ChatSidebar chats={chats} />
}
