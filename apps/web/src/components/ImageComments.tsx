import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { commentThreads, type CommentAnchor, type CommentThread, type CommentView } from '@dorks/shared'
import { useOptionalDorksClient } from '@dorks/client/react'
import type { ThreadActions } from './preview/CommentThread'
import { namesOf, useMaybe, type PreviewSession } from './PreviewBrowser'

// Comments on images: the preview's comment threads (components/preview/), anchored on a point or an area of one of the session's
// images instead of an element of a page. The lightbox draws them with the same bubbles and threads (`PreviewMarks`); the server keeps
// them with the preview's (services/comments.ts) and the agent hears about them the same way, with the image in its turn.

const SessionContext = createContext<PreviewSession | null>(null)

/** The session whose images can be commented on in the lightboxes under it. Without it (the dev demo, the composer's attachments before they are sent) the lightbox only shows images. */
export function ImageCommentsProvider({ session, children }: { session: PreviewSession; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

export type ImageAnchor = Extract<CommentAnchor, { kind: 'image' }>

/** The open threads on one image (by its `dorks-image` id) and how to write them; null where images cannot be commented on. */
export function useImageComments(imageId: string | undefined) {
  const session = useContext(SessionContext)
  const client = useOptionalDorksClient()
  const live = session && client ? client : null
  const all = useMaybe<CommentView[]>(useMemo(() => (live && session ? live.comments(session.id) : null), [live, session]))
  const settings = useMaybe(useMemo(() => live?.settings() ?? null, [live]))
  const threads = useMemo<CommentThread[]>(() => commentThreads(all ?? [], false).filter((t) => t.root.anchor?.kind === 'image' && t.root.anchor.image === imageId), [all, imageId])
  if (!live || !session || !imageId) return null
  const id = session.id
  const actions: ThreadActions = {
    reply: (thread, body) => live.actions.replyComment(id, thread, body),
    resolve: (thread, resolved) => live.actions.changeComment(id, thread, { resolved }),
    edit: (comment, body) => live.actions.changeComment(id, comment, { body }),
    remove: (comment) => live.actions.deleteComment(id, comment),
  }
  return {
    threads,
    names: namesOf(settings?.github.login, session),
    actions,
    add: (anchor: ImageAnchor, body: string) => live.actions.addComment(id, { body, anchor }),
  }
}
