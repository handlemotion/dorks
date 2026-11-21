import { useState } from 'react'
import type { BuildRepo, BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { Textarea } from '@dorks/ui/textarea'
import { usePending } from '../../lib/pending'
import { Runs } from './Runs'

/** Adds a repository, or edits (or removes) one. */
export function RepoDialog({ build, repo, onClose }: { build: BuildView; repo: BuildRepo | null; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [name, setName] = useState(repo?.repo ?? '')
  const [branch, setBranch] = useState(repo?.branch ?? '')
  const [script, setScript] = useState(repo?.setupScript ?? '')
  const { run, pending, error } = usePending()
  const save = (repos: BuildRepo[]) =>
    run(async () => {
      await actions.updateBuild(build.id, { repos })
      onClose()
    })
  const next: BuildRepo = { repo: name.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(script.trim() ? { setupScript: script } : {}) }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void save(repo ? build.repos.map((r) => (r.repo === repo.repo ? next : r)) : [...build.repos, next])
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{repo ? `Edit ${repo.repo}` : 'Add a repository'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">Cloned when the machine is built, then its setup runs inside the clone.</DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="repo-name">Repository</FieldLabel>
              <Input id="repo-name" aria-label="repository" placeholder="owner/name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!repo} />
            </Field>
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
            {repo && (
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
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              {repo ? 'Save' : 'Add repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
