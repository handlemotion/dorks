import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { SettingsGroup, SettingsInputRow, SettingsRow, SettingsSection, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'

export function NameAndDelete({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const [name, setName] = useState(build.name)
  useEffect(() => setName(build.name), [build.name])
  const [confirming, setConfirming] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Build">
      <SettingsGroup label="build name" onSubmit={() => void run(() => actions.updateBuild(build.id, { name }))}>
        <SettingsInputRow
          id="build-name"
          aria-label="build name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          trailing={
            <Button type="submit" size="sm" variant="outline" disabled={pending || !name.trim() || name === build.name}>
              Rename
            </Button>
          }
        />
        <SettingsRow
          label="Delete build"
          control={
            <Button type="button" size="sm" variant="destructive" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Delete {build.name}?</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Its saved image is removed from Boat. Sessions on it keep their machines; one that loses its machine starts again from the base.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await actions.deleteBuild(build.id)
                  setConfirming(false)
                  await navigate({ to: '/builds', search: {} })
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
