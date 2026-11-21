import { useState } from 'react'
import type { BuildVarView, BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Checkbox } from '@dorks/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { usePending } from '../../lib/pending'

const varTitle = (v?: BuildVarView) => (!v ? 'Add a variable' : v.requested ? `Fill in ${v.name}` : `New value for ${v.name}`)

/** A new variable, or a new value for one. */
export function VarDialog({ build, variable, onClose }: { build: BuildView; variable?: BuildVarView; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [name, setName] = useState(variable?.name ?? '')
  const [value, setValue] = useState(variable && !variable.secret ? (variable.value ?? '') : '')
  const [secret, setSecret] = useState(variable?.secret ?? true)
  const [buildTime, setBuildTime] = useState(variable?.buildTime ?? false)
  const { run, pending, error } = usePending()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await actions.setBuildVar(build.id, name.trim(), variable ? { value } : { value, secret, buildTime })
              onClose()
            })
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{varTitle(variable)}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {variable?.secret ? 'Secret values are stored encrypted and never shown again.' : 'Set in every session on this machine.'}
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            {!variable && (
              <Field>
                <FieldLabel htmlFor="var-name">Name</FieldLabel>
                <Input id="var-name" aria-label="variable name" placeholder="NAME_IN_CAPS" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="var-value">Value</FieldLabel>
              <Input
                id="var-value"
                aria-label={variable ? `value of ${variable.name}` : 'variable value'}
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                className="font-mono"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus={!!variable}
              />
            </Field>
            {!variable && (
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={secret} onCheckedChange={(c) => setSecret(c === true)} /> Secret
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={buildTime} onCheckedChange={(c) => setBuildTime(c === true)} /> Needed while building
                </label>
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !name.trim() || (!!variable && !value)}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
