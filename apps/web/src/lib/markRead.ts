import { useEffect } from 'react'
import { useDorksClient } from '@dorks/client/react'

/** A chat whose mark-read the server refused is not asked again for this long (an older server without it, a failing one). */
const RETRY_AFTER_MS = 60_000
const refusedAt = new Map<string, number>()

/**
 * The open chat is read: while it shows an unread finished turn and the window is visible, tell the server, which clears it on every
 * device. A turn that ends while the chat is open is read at once; one that ends in a hidden window is read when the window shows.
 * The dot clears at once (the write is optimistic); a refusal puts it back, and then it is not asked again for a minute, or the
 * flag coming back would ask again in a loop.
 */
export function useMarkRead(dorkId: string, unread: boolean | undefined) {
  const { actions } = useDorksClient()
  useEffect(() => {
    if (!unread) return
    const read = () => {
      if (document.visibilityState !== 'visible' || Date.now() - (refusedAt.get(dorkId) ?? 0) < RETRY_AFTER_MS) return
      void actions.markRead(dorkId).catch(() => refusedAt.set(dorkId, Date.now()))
    }
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [actions, dorkId, unread])
}
