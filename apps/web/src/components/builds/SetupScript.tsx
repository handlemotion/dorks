import { useEffect, useState } from 'react'
import type { BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Textarea } from '@dorks/ui/textarea'
import { SettingsGroup, SettingsGroupFooter, SettingsSection, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { Runs } from './Runs'

export function SetupScript({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [text, setText] = useState(build.setupScript)
  useEffect(() => setText(build.setupScript), [build.setupScript])
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Setup script"
      description={
        <>
          Runs once while building, as <code>user</code> with passwordless sudo in <code>/home/user</code>. Stops at the first failing command.
        </>
      }
    >
      <SettingsGroup label="setup script form" onSubmit={() => void run(() => actions.updateBuild(build.id, { setupScript: text }))}>
        <Textarea
          aria-label="setup script"
          rows={8}
          spellCheck={false}
          className="max-w-none! min-h-40 rounded-none border-0 bg-app/30 px-4 py-3 font-mono text-xs leading-5 focus-visible:ring-0 dark:bg-app/30"
          placeholder="sudo apt-get install -y jq"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" variant="outline" disabled={pending || text === build.setupScript}>
              Save
            </Button>
          }
        >
          {text !== build.setupScript ? 'Unsaved changes. Saving marks the image out of date until you rebuild.' : 'Saving marks the image out of date until you rebuild.'}
        </SettingsGroupFooter>
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}
