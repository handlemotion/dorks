import { useState } from 'react'
import type { BuildRepo, BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { Textarea } from '@dorks/ui/textarea'
import { usePending } from '../../lib/pending'

/** Edits (or removes) one of the build's repositories; they are added from the list beside the section's title. */
export function RepoDialog({ build, repo, onClose }: { build: BuildView; repo: BuildRepo; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [branch, setBranch] = useState(repo.branch ?? '')
  const [script, setScript] = useState(repo.setupScript ?? '')
  const { run, pending, error } = usePending()
  const save = (repos: BuildRepo[]) =>
    run(async () => {
      await actions.updateBuild(build.id, { repos })
      onClose()
    })
  const next: BuildRepo = { repo: repo.repo, ...(branch.trim() ? { branch: branch.trim() } : {}), ...(script.trim() ? { setupScript: script } : {}) }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void save(build.repos.map((r) => (r.repo === repo.repo ? next : r)))
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Edit {repo.repo}</DialogTitle>
            <DialogDescription className="text-sm leading-5">Cloned when the machine is built, then its setup runs inside the clone.</DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="repo-branch">Branch</FieldLabel>
              <Input id="repo-branch" aria-label="branch" placeholder="The default branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="repo-setup">Setup in the clone</FieldLabel>
              <Textarea
                id="repo-setup"
                aria-label="repository setup"
                rows={3}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="pnpm install"
                value={script}
                onChange={(e) => setScript(e.target.value)}
              />
              <FieldDescription>Optional. Runs in the clone after the setup script.</FieldDescription>
            </Field>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="me-auto text-destructive"
              disabled={pending}
              aria-label={`remove ${repo.repo}`}
              onClick={() => void save(build.repos.filter((r) => r.repo !== repo.repo))}
            >
              Remove
            </Button>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
