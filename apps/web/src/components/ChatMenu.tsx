import { useState } from 'react'
import { ExternalLinkIcon, LinkIcon, MoreHorizontalIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLinkItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { BAR_BUTTON } from './PreviewBrowser'
import { Tip } from './Tip'

/**
 * The chat's actions, behind a ••• on the right of its header: open the pull request (when there is one), copy a link to the chat, and
 * delete it after a confirm.
 */
export function ChatMenu({ prUrl, onDelete, detailsOpen }: { prUrl?: string; onDelete?: () => Promise<void> | void; detailsOpen?: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <>
      <DropdownMenu>
        <Tip label="Chat actions">
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={`${BAR_BUTTON} ${detailsOpen ? 'lg:-mr-[11px]' : ''}`} aria-label="Chat actions" />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="w-max">
          <DropdownMenuGroup>
            {prUrl && (
              <DropdownMenuLinkItem href={prUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open pull request
              </DropdownMenuLinkItem>
            )}
            <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => toast('Link copied'))}>
              <LinkIcon />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onDelete && (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent>
            <DialogHeader className="gap-2">
              <DialogTitle className="text-sm font-medium">Delete this chat?</DialogTitle>
              <DialogDescription className="text-sm leading-5">Its transcript and sandbox go away. The pull request stays on GitHub.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true)
                  try {
                    await onDelete()
                    setConfirming(false)
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Could not delete the chat')
                  } finally {
                    setDeleting(false)
                  }
                }}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
