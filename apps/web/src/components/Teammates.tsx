import { useSyncExternalStore } from 'react'
import type { Me, Person } from '@dorks/client'
import { usePresence, useOptionalDorksClient } from '@dorks/client/react'
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from '@dorks/ui/avatar'
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
 * People's pictures by user id: the members of the team org in use (their Dorks Cloud pictures, Settings › Account), and you. Messages
 * and presence name people by id and name only, so the picture is looked up here and follows a change at once.
 */
export function usePictures(): (id: string) => string | null {
  const place = useCloudPlace()
  const org = place?.org && isTeamOrg(place.org) ? place.org : null
  const store = org ? place!.home.cloudOrg(org.id) : null
  const detail = useSyncExternalStore(store?.subscribe ?? noop, store ? () => store.getSnapshot().data : none, store ? () => store.getSnapshot().data : none)
  const me = place?.cloud?.user
  return (id) => (me && me.id === id ? me.image : (detail?.members.find((m) => m.userId === id)?.user.image ?? null))
}

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
  return (
    <span className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
      {by && <PersonAvatar person={by} size="xs" />}
      {name}
    </span>
  )
}

/** A teammate's picture, round and small, or their initials on the muted fill while it loads or when they have none. */
export function PersonAvatar({ person, size = 'sm' }: { person: Person; size?: 'sm' | 'xs' }) {
  const picture = usePictures()(person.id)
  return (
    <Avatar size="sm" className={size === 'xs' ? 'size-4!' : undefined} aria-label={person.name}>
      {picture && <AvatarImage src={picture} alt="" />}
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
