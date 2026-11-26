import { useSyncExternalStore } from 'react'
import type { Me, Person } from '@dorks/client'
import { usePresence, useOptionalDorksClient } from '@dorks/client/react'
import { Avatar, AvatarFallback, AvatarGroup } from '@dorks/ui/avatar'
import { Tip } from './Tip'
import { isTeamOrg, useCloudPlace } from './CloudPlace'

// Team servers (docs/cloud.md): who sent each message, who started a chat, and who is looking at it right now. Only in a team org:
// a personal org (or this Mac with no cloud) has one person, so none of this shows there; and never for your own messages.

const noop = () => () => {}
const none = () => undefined

/** Who this client is to the server; undefined while loading, on an older server, or outside a client (design demos). */
export function useOptionalMe(): Me | undefined {
  const store = useOptionalDorksClient()?.me()
  return useSyncExternalStore(store?.subscribe ?? noop, store ? () => store.getSnapshot().data : none, store ? () => store.getSnapshot().data : none)
}

/** The id this client has in attribution and presence: its cloud user id (the local owner's once the cloud named them), else "owner". */
export const selfId = (me: Me | undefined) => me?.id ?? 'owner'

/**
 * Whether attribution shows here, and whether an id is you. It shows only while a team org is in use (the switcher's); in a
 * personal org everything is yours. You are this server's view of you (`/api/me`), your cloud account, or the local owner.
 */
export function useTeamView(): { team: boolean; isSelf: (id: string) => boolean } {
  const me = useOptionalMe()
  const place = useCloudPlace()
  const team = isTeamOrg(place?.org)
  const mine = new Set([selfId(me), place?.cloud?.user?.id, 'owner'].filter((x): x is string => !!x))
  return { team, isSelf: (id) => mine.has(id) }
}

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
  const { team, isSelf } = useTeamView()
  if (!team) return null
  const name = by ? (isSelf(by.id) ? null : by.name) : me?.kind === 'member' && me.serverOrg ? 'Owner' : null
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
  const { team, isSelf } = useTeamView()
  const others = viewers.filter((v) => !isSelf(v.id))
  if (!team || !others.length) return null
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
