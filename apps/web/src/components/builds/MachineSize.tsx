import type { BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { SettingsGroup, SettingsSelectRow, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { SIZES } from './format'

export function MachineSize({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, error } = usePending()
  return (
    <>
      <SettingsGroup label="machine">
        <SettingsSelectRow
          label="Size"
          description="Billed per second while a session runs: $0.018/h small, $0.036/h default, $0.072/h large, $0.20/h extra large (needs Boat’s $100 plan)."
          value={build.machineType}
          options={SIZES}
          onValueChange={(v) => void run(() => actions.updateBuild(build.id, { machineType: v }))}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </>
  )
}
