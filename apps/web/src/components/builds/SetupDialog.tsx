import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { BuildView } from '@dorks/client'
import { useDorks, useDorksClient, useGithubRepos } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldLabel } from '@dorks/ui/field'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Textarea } from '@dorks/ui/textarea'
import { usePending } from '../../lib/pending'

/**
 * The brief a setup session starts with: with a target repository (cloned in its box), the agent works out what the repository needs
 * and prepares the build end to end on its own: try it in its box, draft, trial-run until it passes, submit for the owner's approval.
 */
export function setupBrief(buildName: string, repo: string, notes: string): string {
  const target = repo ? `so that sessions on ${repo} can start working at once. ${repo} is cloned in this box at ~/work/${repo}.` : 'so that future sessions have what they need.'
  const steps = [
    repo
      ? `Read ${repo} to work out what its development needs: README and docs, AGENTS.md / CLAUDE.md / CONTRIBUTING, package manifests and lockfiles, version files (.nvmrc, .node-version, .tool-versions, rust-toolchain, .python-version, go.mod), CI workflows, Dockerfiles and devcontainers, Makefiles and scripts. List the toolchains, system packages, CLIs, services and environment variables it uses.`
      : 'Ask me which repositories and tools this machine is for, then work out what they need.',
    'Check what this machine already has. Install what is missing here first, then run the install, build, typecheck and test commands until they work.',
    `Call machine_get, then machine_draft: a non-interactive, idempotent setup script for system tools and CLIs${repo ? `, ${repo} in repos with its own setup script for its dependency install` : ''}, \`services\` for each dev server and backing service it runs (the command it runs in the foreground, its directory under ~/work, its port; mark the web UI as a preview) so sessions can start them warm and test against them, a larger machine size only if builds or tests need it, and variables: plain values directly, secrets by name with why, never their values.`,
    'Run a trial with machine_run, read it with machine_logs (use wait), fix and repeat until it succeeds.',
    'Submit with machine_submit and a short note. Then tell me in a few lines what the build installs, and which secrets I need to fill in.',
  ]
  return [
    `Set up the build "${buildName}" ${target} Work end to end on your own; ask me only when a choice is truly mine (an account, a paid service, one of several deploy targets), and otherwise decide and say what you chose.`,
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    ...(notes.trim() ? [`Notes from me: ${notes.trim()}`] : []),
  ].join('\n\n')
}

/** Starting a setup session: the repository it prepares the machine for (cloned in the session's box), and anything the agent should know. */
export function SetupDialog({ build, open, onOpenChange }: { build: BuildView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending, error } = usePending()
  const github = useGithubRepos()
  const dorks = useDorks()
  const repos = [...new Set([...build.repos.map((r) => r.repo), ...(dorks ?? []).map((d) => d.repo).filter(Boolean), ...(github?.repos ?? [])])]
  const [chosen, setRepo] = useState<string>()
  const repo = chosen ?? repos[0] ?? ''
  const [notes, setNotes] = useState('')
  const start = () =>
    run(async () => {
      const { id } = await actions.createDork({ buildId: build.id, setup: true, ...(repo ? { repo } : {}), title: `Set up ${build.name}`, message: setupBrief(build.name, repo, notes) })
      onOpenChange(false)
      await navigate({ to: '/dorks', search: { dork: id } })
    })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">Set up {build.name} with an agent</DialogTitle>
          <DialogDescription className="text-sm leading-5">The agent reads the repository, installs and tests what it needs, trial-runs the build and sends it to you for approval.</DialogDescription>
        </DialogHeader>
        <div data-slot="dialog-body" className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="setup-repo">Repository</FieldLabel>
            <NativeSelect id="setup-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {r}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="">None: I will tell it what the machine is for</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-notes">Notes for the agent</FieldLabel>
            <Textarea id="setup-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional: tools you use, e.g. the Doppler CLI for secrets" />
          </Field>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={pending} onClick={() => void start()}>
            Start setup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
