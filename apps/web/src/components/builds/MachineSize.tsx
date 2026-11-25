import type { BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { SettingsGroup, SettingsSelectRow, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { SIZES, sizeOf } from './format'

export function MachineSize({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, error } = usePending()
  return (
    <>
      <SettingsGroup label="machine">
        <SettingsSelectRow
          label="Size"
          description={`${sizeOf(build.machineType).price} while a session runs`}
          value={build.machineType}
          options={SIZES}
          onValueChange={(v) => void run(() => actions.updateBuild(build.id, { machineType: v }))}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </>
  )
}
