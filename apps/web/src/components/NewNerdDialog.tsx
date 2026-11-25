import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Input } from '@dorks/ui/input'
import { Textarea } from '@dorks/ui/textarea'
import { usePending } from '../lib/pending'

/** The emoji a new nerd can wear in the sidebar. A short, fixed set: picking one is a glance, not a search. */
export const NERD_ICONS = ['🛰️', '🧭', '🚀', '🧪', '🛠️', '📦', '🧠', '🐙', '🦊', '🌱', '⚡', '🎯'] as const

/**
 * Starts a nerd: a coordinator session that plans a long goal and runs worker sessions for it (docs/crew.md). An emoji, an optional
 * name and the goal; the coordinator needs no repository of its own, it picks one per worker.
 */
export function NewNerdDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const [icon, setIcon] = useState<string>(NERD_ICONS[0])
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const { run, pending, error } = usePending()
  const start = () =>
    run(async () => {
      const { id } = await actions.createDork({ mode: 'nerd', icon, message: goal.trim(), ...(name.trim() ? { title: name.trim() } : {}) })
      onOpenChange(false)
      setName('')
      setGoal('')
      await navigate({ to: '/dorks', search: { dork: id } })
    })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">New nerd</DialogTitle>
          <DialogDescription className="text-sm leading-5">A nerd plans a long goal and runs sessions for it. It doesn't write code itself.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (goal.trim() && !pending) void start()
          }}
        >
          <div role="radiogroup" aria-label="Icon" className="grid grid-cols-6 gap-1">
            {NERD_ICONS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={icon === e}
                aria-label={e}
                onClick={() => setIcon(e)}
                className="flex h-9 items-center justify-center rounded-[6px] text-lg transition-none outline-none hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-ring aria-checked:bg-foreground/[0.07]"
              >
                {e}
              </button>
            ))}
          </div>
          <Input aria-label="Name" placeholder="Name (optional)" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <Textarea
            aria-label="Goal"
            placeholder="What should it get done? The goal, the repositories, what done looks like."
            className="min-h-28"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
            }}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" type="button" />}>Cancel</DialogClose>
            <Button size="sm" type="submit" disabled={!goal.trim() || pending}>
              {pending ? 'Starting…' : 'Start nerd'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
