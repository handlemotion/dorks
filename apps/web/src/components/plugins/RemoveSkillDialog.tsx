import type { SkillView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { toast } from 'sonner'
import { usePending } from '../../lib/pending'

/** Confirms Remove from this computer: a skill from ~/.agents/skills or ~/.claude/skills is deleted there, for every agent. */
export function RemoveFromComputerDialog({ skill, onClose, onRemoved }: { skill: SkillView; onClose: () => void; onRemoved?: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">Remove {skill.name} from this computer?</DialogTitle>
          <DialogDescription className="text-sm leading-5">
            Deletes <span className="font-mono text-xs">{skill.local}</span> and its links in other agents' skill folders, so Claude Code and every other agent on this computer lose it too, as do your
            sessions.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await actions.removeSkillFromComputer(skill.name)
                toast.success(`Removed ${skill.name} from this computer`)
                onClose()
                onRemoved?.()
              })
            }
          >
            {pending ? 'Removing…' : 'Remove from computer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
