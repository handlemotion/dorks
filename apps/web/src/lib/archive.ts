import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useDorksClient } from '@dorks/client/react'

/**
 * The chat to open when `id` leaves the sidebar: the row under it, or the one above when it is the last, in the order the sidebar
 * shows them (its groups and the user's drag order). Read before the archive, while the row is still there.
 */
function neighborOf(id: string): string | undefined {
  const ids = [...document.querySelectorAll<HTMLElement>('[data-chat-id]')].map((row) => row.dataset.chatId!)
  const index = ids.indexOf(id)
  if (index < 0) return ids[0]
  return ids[index + 1] ?? ids[index - 1]
}

/**
 * Archives (or restores) a chat. Archiving the chat that is open moves to the next one in the sidebar, or to a new session when it
 * was the only one, instead of leaving the page on an archived chat. The row leaves at once (the client's write is optimistic) and
 * the page moves on without waiting for the server; a refusal puts the row back and rejects, for the caller to say so.
 */
export function useArchiveDork() {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { search } = useLocation()
  const openId = (search as { dork?: unknown }).dork
  return useCallback(
    async (id: string, archived = true) => {
      const next = archived && id === openId ? neighborOf(id) : undefined
      const done = actions.archiveDork(id, archived)
      if (archived && id === openId) await navigate({ to: '/dorks', search: next ? { dork: next } : {} })
      await done
    },
    [actions, navigate, openId],
  )
}
