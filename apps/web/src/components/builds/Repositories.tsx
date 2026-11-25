import { useState } from 'react'
import type { BuildRepo, BuildView } from '@dorks/client'
import { useDorks, useDorksClient, useGithubRepos } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { SettingsGroup, SettingsGroupBody, SettingsSection } from '../settings/kit'
import { RepoCommand } from '../EnvironmentPicker'
import { OwnerAvatar, ownerOf } from '../RepoAvatar'
import { usePending } from '../../lib/pending'
import { firstLine } from './format'
import { ROW, RowText } from './shared'
import { RepoDialog } from './RepoDialog'

/** At most this many repositories per build (docs/builds.md, "Limits"). */
const MAX_REPOS = 10

export function Repositories({ build }: { build: BuildView }) {
  const [editing, setEditing] = useState<BuildRepo | null>(null)
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const add = (repo: string) => run(() => actions.updateBuild(build.id, { repos: [...build.repos, { repo }] }))
  return (
    <SettingsSection
      title="Repositories"
      description={
        <>
          Cloned into <code>~/work/owner/name</code> when the machine is built. Sessions fetch before they start. A new session on this build starts in the first one.
        </>
      }
      actions={build.repos.length < MAX_REPOS && <AddRepository build={build} disabled={pending} onPick={(repo) => void add(repo)} />}
    >
      <SettingsGroup label="repositories">
        {build.repos.length === 0 && <SettingsGroupBody>No repositories yet. Each one is cloned and set up when the machine is built.</SettingsGroupBody>}
        {build.repos.map((r) => (
          <div key={r.repo} className={ROW}>
            <OwnerAvatar owner={ownerOf(r.repo)} />
            <RowText
              title={<span className="font-mono text-xs">{r.repo}</span>}
              description={
                <>
                  {r.branch ?? 'Default branch'} ·{' '}
                  {r.setupScript?.trim() ? (
                    <>
                      then <code className="font-mono">{firstLine(r.setupScript)}</code>
                    </>
                  ) : (
                    'no setup'
                  )}
                </>
              }
            />
            <Button size="sm" variant="ghost" aria-label={`edit ${r.repo}`} onClick={() => setEditing(r)}>
              Edit
            </Button>
          </div>
        ))}
        {error && (
          <SettingsGroupBody>
            <p role="alert" className="text-destructive">
              {error}
            </p>
          </SettingsGroupBody>
        )}
      </SettingsGroup>
      {editing && <RepoDialog build={build} repo={editing} onClose={() => setEditing(null)} />}
    </SettingsSection>
  )
}

/** Add repository: the same searchable list the new session's chooser offers (the GitHub CLI login's and the ones chats used). */
function AddRepository({ build, disabled, onPick }: { build: BuildView; disabled: boolean; onPick: (repo: string) => void }) {
  const [open, setOpen] = useState(false)
  const github = useGithubRepos()
  const dorks = useDorks()
  const added = new Set(build.repos.map((r) => r.repo.toLowerCase()))
  const recent = [...new Set(dorks?.map((d) => d.repo).filter(Boolean) ?? [])].sort()
  const repositories = [...new Set([...recent, ...(github?.repos ?? [])])].filter((r) => !added.has(r.toLowerCase()))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} render={<Button size="sm" variant="ghost" />}>
        Add repository
      </PopoverTrigger>
      <PopoverContent align="end" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 ring-0`}>
        {open && (
          <RepoCommand
            repositories={repositories}
            onPick={(repo) => {
              setOpen(false)
              if (!added.has(repo.toLowerCase())) onPick(repo)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
