import { toast } from 'sonner'
import type { Person } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { useCloudPlace } from '../components/CloudPlace'
import { useTeamView } from '../components/Teammates'

/**
 * Who sees a chat in a Teams org on Dorks Cloud: only who started it, until they share it with the team (and they can make it private
 * again). `sharing(chat)` is the switch for a chat you started there, else undefined (a teammate's chat, an automation's, another place).
 */
export function useChatSharing(): (chat: { id: string; shared?: boolean; createdBy?: Person }) => { shared: boolean; label: string; toggle: () => void } | undefined {
  const { team, isSelf } = useTeamView()
  const { actions } = useDorksClient()
  return (chat) => {
    if (!team || chat.shared === undefined || !chat.createdBy || !isSelf(chat.createdBy.id)) return undefined
    const shared = chat.shared
    return {
      shared,
      label: shared ? 'Make private' : 'Share with team',
      toggle: () =>
        void actions.shareDork(chat.id, !shared).then(
          () => toast(shared ? 'Only you can see this chat now' : 'Shared with your team'),
          (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not change who sees this chat'),
        ),
    }
  }
}

/** Whether a new chat picks who sees it: in a team that runs on Dorks Cloud. */
export function useNewChatSharing(): boolean {
  const place = useCloudPlace()
  return place?.target.kind === 'cloud' && !!place.org && !place.org.personal
}
