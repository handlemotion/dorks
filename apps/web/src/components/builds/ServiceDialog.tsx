import { useState } from 'react'
import type { BuildService, BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Checkbox } from '@dorks/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { usePending } from '../../lib/pending'

type Form = { name: string; command: string; cwd: string; port: string; preview: boolean }

const formOf = (build: BuildView, s: BuildService | null): Form => ({
  name: s?.name ?? '',
  command: s?.command ?? '',
  cwd: s ? (s.cwd ?? '') : (build.repos[0]?.repo ?? ''),
  port: s?.port ? String(s.port) : '',
  preview: !!s?.preview,
})

/** The form as a service: the directory relative to ~/work, a port only when it is a number. */
function serviceOf(f: Form): BuildService {
  const port = Number(f.port)
  const cwd = f.cwd.trim().replace(/^~?\/?work\/?/, '')
  return {
    name: f.name.trim(),
    command: f.command.trim(),
    ...(cwd ? { cwd } : {}),
    ...(f.port.trim() && Number.isInteger(port) ? { port } : {}),
    ...(f.preview ? { preview: true } : {}),
  }
}

/** Adds a service, or edits (or removes) one. */
export function ServiceDialog({ build, service, onClose }: { build: BuildView; service: BuildService | null; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [form, setForm] = useState(() => formOf(build, service))
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const { name, command, cwd, port, preview } = form
  const { run, pending, error } = usePending()
  const save = (services: BuildService[]) =>
    run(async () => {
      await actions.updateBuild(build.id, { services })
      onClose()
    })
  const next = serviceOf(form)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void save(service ? build.services.map((s) => (s.name === service.name ? next : s)) : [...build.services, next])
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{service ? `Edit ${service.name}` : 'Add a service'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Started once while the machine is built, to check it and warm its caches. Never started at boot: agents start it when they need it.
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="service-name">Name</FieldLabel>
              <Input id="service-name" aria-label="service name" placeholder="web" value={name} onChange={(e) => set({ name: e.target.value })} autoFocus={!service} />
            </Field>
            <Field>
              <FieldLabel htmlFor="service-command">Command</FieldLabel>
              <Input
                id="service-command"
                aria-label="service command"
                className="font-mono text-xs"
                placeholder="pnpm dev --host 0.0.0.0 --port 5173"
                value={command}
                onChange={(e) => set({ command: e.target.value })}
              />
              <FieldDescription>Runs in the foreground until stopped, as the agent, with the build's variables.</FieldDescription>
            </Field>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel htmlFor="service-cwd">Directory under ~/work</FieldLabel>
                <Input id="service-cwd" aria-label="service directory" className="font-mono text-xs" placeholder="owner/name" value={cwd} onChange={(e) => set({ cwd: e.target.value })} />
              </Field>
              <Field className="w-28">
                <FieldLabel htmlFor="service-port">Port</FieldLabel>
                <Input id="service-port" aria-label="service port" inputMode="numeric" placeholder="5173" value={port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
              </Field>
            </div>
            <Field orientation="horizontal">
              <Checkbox id="service-preview" aria-label="show as a preview" checked={preview} onCheckedChange={(v) => set({ preview: v === true })} />
              <FieldLabel htmlFor="service-preview" className="font-normal">
                Show it to me as a running preview when an agent starts it
              </FieldLabel>
            </Field>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {service && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="me-auto"
                disabled={pending}
                aria-label={`remove ${service.name}`}
                onClick={() => void save(build.services.filter((s) => s.name !== service.name))}
              >
                Remove
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !next.name || !next.command || (preview && !next.port)}>
              {service ? 'Save' : 'Add service'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
