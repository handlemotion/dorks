import { useEffect } from 'react'
import { useDorksClient } from '@dorks/client/react'

/**
 * The open chat is read: while it shows an unread finished turn and the window is visible, tell the server, which clears it on every
 * device. A turn that ends while the chat is open is read at once; one that ends in a hidden window is read when the window shows.
 */
export function useMarkRead(dorkId: string, unread: boolean | undefined) {
  const { actions } = useDorksClient()
  useEffect(() => {
    if (!unread) return
    const read = () => {
      if (document.visibilityState === 'visible') void actions.markRead(dorkId).catch(() => {})
    }
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [actions, dorkId, unread])
}
