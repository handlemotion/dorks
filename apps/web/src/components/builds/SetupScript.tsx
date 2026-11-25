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
          Runs once while building, as <code>user</code> with sudo. Stops at the first failure.
        </>
      }
    >
      <SettingsGroup label="setup script form" onSubmit={() => void run(() => actions.updateBuild(build.id, { setupScript: text }))}>
        <Textarea
          aria-label="setup script"
          rows={8}
          spellCheck={false}
          className="max-w-none! min-h-32 rounded-none border-0 bg-transparent px-4 py-3 font-mono text-xs leading-5 md:text-xs focus-visible:ring-0 dark:bg-transparent"
          placeholder="sudo apt-get install -y jq"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {text !== build.setupScript && (
          <SettingsGroupFooter
            action={
              <>
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setText(build.setupScript)}>
                  Discard
                </Button>
                <Button type="submit" size="sm" disabled={pending}>
                  Save
                </Button>
              </>
            }
          >
            Unsaved changes
          </SettingsGroupFooter>
        )}
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}
