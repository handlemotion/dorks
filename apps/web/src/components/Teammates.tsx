import { useSyncExternalStore } from 'react'
import type { Me, Person } from '@dorks/client'
import { usePresence, useOptionalDorksClient } from '@dorks/client/react'
import { Avatar, AvatarFallback, AvatarGroup } from '@dorks/ui/avatar'
import { Tip } from './Tip'

// Team servers (docs/cloud.md): who sent each message, who started a chat, and who is looking at it right now. On a server nobody
// else uses, none of this shows.

const noop = () => () => {}
const none = () => undefined

/** Who this client is to the server; undefined while loading, on an older server, or outside a client (design demos). */
export function useOptionalMe(): Me | undefined {
  const store = useOptionalDorksClient()?.me()
  return useSyncExternalStore(store?.subscribe ?? noop, store ? () => store.getSnapshot().data : none, store ? () => store.getSnapshot().data : none)
}

/** The id this client has in attribution and presence: its cloud user id (the local owner's once the cloud named them), else "owner". */
export const selfId = (me: Me | undefined) => me?.id ?? 'owner'

/** Up to two initials of a name. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

/**
 * The name over a user message sent by someone else. A teammate's message carries `by`; on a team server, a message without one is
 * the local owner's.
 */
export function SenderName({ by }: { by?: Person }) {
  const me = useOptionalMe()
  const name = by ? (by.id === selfId(me) ? null : by.name) : me?.kind === 'member' && me.serverOrg ? 'Owner' : null
  if (!name) return null
  return <span className="px-1 text-xs text-muted-foreground">{name}</span>
}

/** A teammate's round initials, small, on the muted fill (no picture: the cloud token names people, it has no avatar). */
export function PersonAvatar({ person, size = 'sm' }: { person: Person; size?: 'sm' | 'xs' }) {
  return (
    <Avatar size="sm" className={size === 'xs' ? 'size-4!' : undefined} aria-label={person.name}>
      <AvatarFallback className={size === 'xs' ? 'text-[8px]!' : 'text-[10px]!'}>{initials(person.name)}</AvatarFallback>
    </Avatar>
  )
}

const names = (people: Person[]) =>
  people.length === 1
    ? people[0]!.name
    : `${people
        .slice(0, -1)
        .map((p) => p.name)
        .join(', ')} and ${people.at(-1)!.name}`

/** Who else is looking at this chat now, in its header. Nothing when it is only you. */
export function PresenceAvatars({ dorkId }: { dorkId: string }) {
  const viewers = usePresence(dorkId)
  const me = useOptionalMe()
  const others = viewers.filter((v) => v.id !== selfId(me))
  if (!others.length) return null
  const shown = others.slice(0, 3)
  return (
    <Tip label={`${names(others)} ${others.length === 1 ? 'is' : 'are'} here`}>
      <AvatarGroup className="mr-1.5" aria-label={`Also here: ${names(others)}`} role="group">
        {shown.map((p) => (
          <PersonAvatar key={p.id} person={p} />
        ))}
        {others.length > shown.length && (
          <Avatar size="sm">
            <AvatarFallback className="text-[10px]!">+{others.length - shown.length}</AvatarFallback>
          </Avatar>
        )}
      </AvatarGroup>
    </Tip>
  )
}
