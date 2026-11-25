import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BuildView } from '@dorks/client'
import { useBuild, useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { EmptyState } from '../EmptyState'
import { PageHeader } from '../PageHeader'
import { SettingsSection } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { canBuild, missingVars } from './format'
import { Page, BuildCrumb } from './shared'
import { Overview } from './Overview'
import { AgentChanges } from './AgentChanges'
import { SetupScript } from './SetupScript'
import { Repositories } from './Repositories'
import { Services } from './Services'
import { Variables } from './Variables'
import { MachineSize } from './MachineSize'
import { Runs } from './Runs'
import { NameAndDelete } from './NameAndDelete'
import { RunPage } from './RunPage'
import { ReviewPage } from './ReviewPage'
import { SetupDialog } from './SetupDialog'

export function BuildPage({ id, run, review }: { id: string; run?: string; review?: string }) {
  const build = useBuild(id)
  if (build === undefined) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (build === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Builds" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This build no longer exists">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" />}>
              Back to builds
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  if (run) return <RunPage build={build} runId={run} />
  if (review) return <ReviewPage build={build} draftId={review} />
  return <BuildDetails build={build} />
}

function BuildDetails({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  const missing = missingVars(build)
  const [settingUp, setSettingUp] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<BuildCrumb />}
        title={build.name}
        actions={
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSettingUp(true)}>
              Set up with an agent
            </Button>
            <SetupDialog build={build} open={settingUp} onOpenChange={setSettingUp} />
            {build.activeRun ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.cancelRun(build.id, build.activeRun!.id))}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" disabled={pending || !canBuild(build, missing)} onClick={() => void run(() => actions.startRun(build.id, 'image'))}>
                {build.image ? 'Rebuild' : 'Build'}
              </Button>
            )}
          </>
        }
      />
      <Page>
        <Overview build={build} />
        <AgentChanges build={build} />
        <Repositories build={build} />
        <SetupScript build={build} />
        <Services build={build} />
        <Variables build={build} />
        <SettingsSection title="Machine">
          <MachineSize build={build} />
        </SettingsSection>
        <Runs build={build} />
        <NameAndDelete build={build} />
      </Page>
    </div>
  )
}
