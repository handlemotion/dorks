import { useState } from 'react'
import { GitBranchIcon } from 'lucide-react'
import type { BuildRepo, BuildView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { SettingsGroup, SettingsGroupBody, SettingsSection } from '../settings/kit'
import { firstLine } from './format'
import { ROW, RowText } from './shared'
import { RepoDialog } from './RepoDialog'

export function Repositories({ build }: { build: BuildView }) {
  const [editing, setEditing] = useState<BuildRepo | 'new' | null>(null)
  return (
    <SettingsSection
      title="Repositories"
      description={
        <>
          Cloned into <code>~/work/owner/name</code> when the machine is built. Sessions fetch before they start.
        </>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
          Add repository
        </Button>
      }
    >
      <SettingsGroup label="repositories">
        {build.repos.length === 0 && <SettingsGroupBody>No repositories yet. Each one is cloned and set up when the machine is built.</SettingsGroupBody>}
        {build.repos.map((r) => (
          <div key={r.repo} className={ROW}>
            <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
      </SettingsGroup>
      {editing && <RepoDialog build={build} repo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </SettingsSection>
  )
}
