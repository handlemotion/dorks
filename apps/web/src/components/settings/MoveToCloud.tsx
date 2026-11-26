import { useEffect, useState } from 'react'
import type { CloudMoveStatus, CloudOrg } from '@dorks/client'
import { useStoreValue } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Progress } from '@dorks/ui/progress'
import { usePending } from '../../lib/pending'
import { isPaidOrg, runsOnWorker } from '../../lib/place'
import { orgName, type CloudPlace } from '../CloudPlace'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelectRow, SettingsStatus, SettingsValueRow } from './kit'

// Settings › Organization › Where it runs (docs/move-to-cloud.md). A paid workspace (Teams or Cloud, the personal one included) that
// this Mac still serves moves to Dorks Cloud: this Mac pauses its sessions and uploads them with their transcripts, builds,
// automations, MCP servers, skills, shared variables and settings, and the cloud takes it over (AutoMove.tsx starts it on its own; this
// is where it is retried). The free personal workspace can instead be moved into a paid team the owner manages: everything is copied
// there, and the sessions are archived here. Owners and admins only (the cloud checks too).

const RUNNING: CloudMoveStatus['phase'][] = ['pausing', 'uploading', 'committing']

/** Whether the section shows at all: a paid org that this Mac serves (its server's org), or one the Worker runs. */
export function showsWhereItRuns(org: CloudOrg, serverOrg: string | null | undefined) {
  return isPaidOrg(org) && (runsOnWorker(org) || serverOrg === org.id)
}

/** The paid teams the free personal workspace on this Mac can be moved into: ones the account owns or administers. */
export function moveTargets(place: CloudPlace, org: CloudOrg, serverOrg: string | null | undefined): CloudOrg[] {
  if (!org.personal || isPaidOrg(org) || serverOrg !== org.id) return []
  return (place.places?.orgs ?? []).filter((o) => !o.personal && isPaidOrg(o) && /\b(owner|admin)\b/.test(o.role ?? ''))
}

export function WhereItRuns({ place, org, admin }: { place: CloudPlace; org: CloudOrg; admin: boolean }) {
  const status = useStoreValue(place.home.cloudMove()).data
  const [confirming, setConfirming] = useState(false)
  const { run, pending, error } = usePending()
  const mine = status?.orgId === org.id ? status : undefined
  const running = !!mine && RUNNING.includes(mine.phase)
  // Progress is polled while a move runs; when it ends, the org list is read again: without this Mac in it, the app follows the org to the cloud.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => place.home.refreshCloudMove(), 1000)
    return () => clearInterval(t)
  }, [running, place.home])
  useEffect(() => {
    if (mine?.phase === 'done') place.home.refreshCloudPlaces()
  }, [mine?.phase, place.home])

  return (
    <SettingsSection title="Where it runs">
      <SettingsGroup label="where it runs">
        <WhereRow place={place} org={org} admin={admin} mine={mine} running={running} pending={pending} onMove={() => setConfirming(true)} />
      </SettingsGroup>
      <SettingsStatus error={error ?? (mine?.phase === 'failed' ? (mine.error ?? 'The move failed.') : undefined)} />
      <MoveDialog
        org={org}
        open={confirming}
        onOpenChange={setConfirming}
        pending={pending}
        onConfirm={() =>
          void run(async () => {
            await place.home.actions.cloudStartMove(org.id)
            setConfirming(false)
          })
        }
      />
    </SettingsSection>
  )
}

/** Where the org runs now: Dorks Cloud, a move in progress, or this Mac (with the button). */
function WhereRow(p: { place: CloudPlace; org: CloudOrg; admin: boolean; mine: CloudMoveStatus | undefined; running: boolean; pending: boolean; onMove: () => void }) {
  const { org, mine } = p
  if (runsOnWorker(org) || mine?.phase === 'done')
    return (
      <SettingsValueRow
        label="Dorks Cloud"
        description={
          mine?.phase === 'done' ? `Moved from this Mac with ${count(mine.sessions.total, 'session')}. This Mac keeps a paused copy.` : 'Sessions run in cloud sandboxes, also when your Mac is off.'
        }
        value="Running"
        tone="success"
      />
    )
  if (p.running && mine) return <SettingsRow label={phaseLabel(mine)} description="Keep this Mac on until it finishes." control={<MoveProgress status={mine} />} />
  const mac = org.servers.find((s) => s.kind === 'mac' && s.id === p.place.thisMacId)
  return (
    <SettingsRow
      label={`On ${mac?.name || 'this Mac'}`}
      description={p.admin ? 'Sessions run while this Mac is on. Move to Dorks Cloud to keep them running when it is off.' : 'Owners and admins can move it to Dorks Cloud.'}
      control={
        p.admin && (
          <Button size="sm" variant="outline" disabled={p.pending} onClick={p.onMove}>
            {mine?.phase === 'failed' ? 'Try again' : 'Move to cloud'}
          </Button>
        )
      }
    />
  )
}

function MoveDialog(p: { org: CloudOrg; open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onConfirm: () => void }) {
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      <DialogContent>
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">Move {p.org.name} to Dorks Cloud?</DialogTitle>
          <DialogDescription className="text-sm leading-5">
            Its sessions pause, then they move with their chats, builds, automations, MCP servers, skills, shared variables and settings. Afterwards it runs in the cloud, also when this Mac is off,
            and this Mac keeps a paused copy. Sign-ins (Claude, Boat, Sentry) are entered again in the cloud.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={p.pending} onClick={p.onConfirm}>
            Move to cloud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MoveProgress({ status }: { status: CloudMoveStatus }) {
  const { done, total } = status.events
  const value = status.phase === 'committing' ? 100 : total ? Math.round((done / total) * 100) : 0
  return <Progress value={value} aria-label="move progress" className="w-40 [&_[data-slot=progress-track]]:h-1.5" />
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

function phaseLabel(s: CloudMoveStatus) {
  if (s.phase === 'pausing') return 'Pausing sessions…'
  if (s.phase === 'committing') return 'Switching to Dorks Cloud…'
  return `Uploading ${Math.min(s.sessions.done + 1, s.sessions.total)} of ${count(s.sessions.total, 'session')}…`
}

/**
 * Settings › Organization, the free personal workspace: move everything on this Mac into a paid team (its chats, builds, automations
 * and the rest), which runs in the cloud. The sessions are archived here afterwards; the workspace itself stays, on this Mac.
 */
export function MoveIntoTeam({ place, targets }: { place: CloudPlace; targets: CloudOrg[] }) {
  const status = useStoreValue(place.home.cloudMove()).data
  const [orgId, setOrgId] = useState(targets[0]!.id)
  const [confirming, setConfirming] = useState(false)
  const { run, pending, error } = usePending()
  const target = targets.find((o) => o.id === orgId) ?? targets[0]!
  const mine = status && targets.some((o) => o.id === status.orgId) ? status : undefined
  const running = !!mine && RUNNING.includes(mine.phase)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => place.home.refreshCloudMove(), 1000)
    return () => clearInterval(t)
  }, [running, place.home])
  const done = mine?.phase === 'done' ? targets.find((o) => o.id === mine.orgId) : undefined
  return (
    <SettingsSection
      title="Move to a team"
      description="Your workspace runs on this Mac. Move its sessions, builds and automations into a team on Dorks Cloud to keep them running when this Mac is off."
    >
      <SettingsGroup label="move to a team">
        {targets.length > 1 && !running && <SettingsSelectRow label="Team" value={orgId} onValueChange={(v) => setOrgId(v as string)} options={targets.map((o) => ({ value: o.id, label: o.name }))} />}
        {running && mine ? (
          <SettingsRow label={phaseLabel(mine)} description="Keep this Mac on until it finishes." control={<MoveProgress status={mine} />} />
        ) : done ? (
          <SettingsValueRow label={done.name} description={`Moved ${count(mine!.sessions.total, 'session')}. They are archived here.`} value="Moved" tone="success" />
        ) : (
          <SettingsRow
            label={target.name}
            description={`Everything moves into ${target.name}. Its members will see the moved sessions.`}
            control={
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(true)}>
                {mine?.phase === 'failed' ? 'Try again' : 'Move'}
              </Button>
            }
          />
        )}
      </SettingsGroup>
      <SettingsStatus error={error ?? (mine?.phase === 'failed' ? (mine.error ?? 'The move failed.') : undefined)} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">
              Move {orgName(null, place.cloud)} into {target.name}?
            </DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Your sessions pause, then they move into {target.name} with their chats, builds, automations, MCP servers, skills and shared variables. Its members will see them. Afterwards they run in
              the cloud, and they are archived on this Mac. Names {target.name} already has are kept as they are there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await place.home.actions.cloudStartMove(target.id)
                  setConfirming(false)
                })
              }
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
