import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleCheckIcon, CircleIcon } from 'lucide-react'
import type { Settings, SnapshotStatus } from '@dorks/client'
import { useDorksClient, useSecretNames, useSnapshot } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { Progress } from '@dorks/ui/progress'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../EmptyState'
import { saveBoat } from '../../lib/boat'
import { isDesktop, setPublicUrl } from '../../lib/desktop'
import { STEPS, stepDone } from '../../lib/onboarding'
import { usePending } from '../../lib/pending'
import {
  SettingsGroup,
  SettingsGroupBody,
  SettingsGroupFooter,
  SettingsInputRow,
  SettingsRow,
  SettingsSection,
  SettingsSections,
  SettingsSelectRow,
  SETTINGS_TONE,
  SettingsStatus,
  SettingsValueRow,
} from './kit'

// The pages shared by everyone using this server: the setup checklist, the Boat account sessions run in, the base snapshot they start
// from, how sessions behave, the variables they all get, and the public URL sandboxes dial back to.

export function SetupPage({ settings }: { settings: Settings }) {
  const done = stepDone(settings)
  const rows = [...STEPS.map((s) => ({ id: s.id, title: s.title, done: done[s.id] })), { id: 'tunnel', title: 'Public URL for sandboxes (the tunnel)', done: settings.publicUrlConfigured }]
  return (
    <SettingsSections>
      <SettingsSection title="Checklist">
        <SettingsGroup label="setup checklist">
          {rows.map((r) => (
            <SettingsValueRow
              key={r.id}
              icon={r.done ? DoneIcon : TodoIcon}
              label={<span data-testid={`check-${r.id}`}>{r.title}</span>}
              value={r.done ? 'Done' : 'To do'}
              tone={r.done ? 'success' : 'muted'}
            />
          ))}
          {!settings.publicUrlConfigured && (
            <SettingsGroupBody role="status">
              <p>
                No public URL is configured, so sandboxes cannot reach this machine. The desktop app sets it up; when running the server by hand, set <code>DORKS_PUBLIC_URL</code>.
              </p>
            </SettingsGroupBody>
          )}
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Guided setup">
        <SettingsGroup>
          <SettingsRow
            label="Run the guided setup"
            description="Walks through each step again, one screen at a time."
            control={
              <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/onboarding" />}>
                Open
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsSections>
  )
}

function DoneIcon({ className }: { className?: string }) {
  return <CircleCheckIcon aria-label="done" className={`${className ?? ''} text-emerald-600 dark:text-emerald-400`} />
}

function TodoIcon({ className }: { className?: string }) {
  return <CircleIcon aria-label="not done" className={className} />
}

export function BoatPage({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const [key, setKey] = useState('')
  const [org, setOrg] = useState(settings.boatOrg ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSections>
      <SettingsSection title="Account" description="Sessions run in sandboxes in this Boat account.">
        <SettingsGroup
          label="boat account"
          onSubmit={() => {
            setSaved(false)
            void run(async () => {
              await saveBoat(actions, key.trim(), org.trim(), settings.boatOrg)
              setKey('')
              setSaved(true)
            })
          }}
        >
          <SettingsInputRow
            id="boat-key"
            label="API key"
            description={settings.boatKey ? 'A key is saved.' : 'Not set.'}
            aria-label="boat api key"
            type="password"
            autoComplete="off"
            placeholder={settings.boatKey ? 'Replace the key' : 'boat_…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <SettingsInputRow
            id="boat-org"
            label="Organization"
            description="Optional, only to bill a team wallet."
            aria-label="boat organization"
            autoComplete="off"
            placeholder="Personal wallet"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
          <SettingsGroupFooter
            action={
              <Button type="submit" size="sm" disabled={pending || (!key && !settings.boatKey)}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            }
          >
            Create the key in your Boat account with access to create, list, use and delete sandboxes. It is stored encrypted on this machine and never shown again.
          </SettingsGroupFooter>
        </SettingsGroup>
        <SettingsStatus saved={saved} error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}

/** What the snapshot in use is: building, failed, ready, out of date or entered by hand. */
function snapshotState(snap: SnapshotStatus, inUse: string | null): { value: string; tone: 'default' | 'muted' | 'danger' | 'success' } {
  if (snap.state === 'building') return { value: 'Building', tone: 'muted' }
  if (snap.state === 'failed') return { value: 'Failed', tone: 'danger' }
  if (!inUse) return { value: 'Not built', tone: 'muted' }
  if (!snap.managed) return { value: 'Entered by hand', tone: 'default' }
  if (snap.stale) return { value: 'Update available', tone: 'default' }
  return { value: 'Ready', tone: 'success' }
}

/** The one build button the snapshot's state calls for, if any. */
function snapshotAction(snap: SnapshotStatus): { label: string; force?: boolean; variant?: 'outline' } | undefined {
  if (snap.state === 'failed') return { label: 'Retry' }
  if (!snap.managed) return { label: 'Prepare Boat' }
  if (snap.stale) return { label: 'Update snapshot' }
  if (snap.state === 'building') return undefined
  return { label: 'Rebuild', force: true, variant: 'outline' }
}

/**
 * "Prepare Boat": builds the base snapshot in the user's Boat account with one click and follows the build step by step (the server
 * pushes each step over the live stream). A snapshot built some other way can still be entered by hand below.
 */
export function SnapshotPage({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const snap = useSnapshot()
  const { run, pending, error } = usePending()
  const build = (force = false) => void run(async () => void (await actions.buildSnapshot(force)))
  const inUse = settings.baseSnapshotId
  return (
    <SettingsSections>
      <SettingsSection title="Base snapshot" description="Every session starts from a saved snapshot in your Boat account that holds the bridge and the agent tools, with no credentials in it.">
        {!snap ? (
          <SettingsGroup>
            <SettingsGroupBody role="status">
              <p>Checking the base snapshot…</p>
            </SettingsGroupBody>
          </SettingsGroup>
        ) : (
          <SnapshotGroup snap={snap} inUse={inUse} pending={pending} build={build} />
        )}
        <SettingsStatus error={error} />
      </SettingsSection>
      <ManualSnapshot settings={settings} />
    </SettingsSections>
  )
}

function SnapshotGroup({ snap, inUse, pending, build }: { snap: SnapshotStatus; inUse: string | null; pending: boolean; build: (force?: boolean) => void }) {
  const building = snap.state === 'building'
  const blocked = !snap.canBuild
  const action = snapshotAction(snap)
  const state = snapshotState(snap, inUse)
  return (
    <SettingsGroup>
      <SettingsRow
        label="Status"
        description={inUse ? <code data-testid="snapshot-in-use">{inUse}</code> : 'Dorks builds it in a temporary sandbox, saves it, and deletes the sandbox.'}
        control={
          <>
            <span className={`text-sm ${SETTINGS_TONE[state.tone]}`}>{state.value}</span>
            {action && !building && (
              <Button type="button" size="sm" variant={action.variant} disabled={pending || blocked} onClick={() => build(action.force)}>
                {pending ? 'Starting…' : action.label}
              </Button>
            )}
          </>
        }
      />
      {building && (
        <SettingsGroupBody role="status" aria-label="snapshot build progress" data-testid="snapshot-progress">
          <p className="text-foreground">
            Step {snap.stepIndex + 1} of {snap.stepCount}: {snap.message}
          </p>
          <Progress value={((snap.stepIndex + 1) / snap.stepCount) * 100} aria-label="build progress" />
        </SettingsGroupBody>
      )}
      {!building && <SnapshotNotes snap={snap} inUse={inUse} />}
      {blocked && snap.cannotBuildReason && (
        <SettingsGroupBody role="status">
          <p>{snap.cannotBuildReason}</p>
        </SettingsGroupBody>
      )}
      <SettingsGroupBody>
        <p>A build takes a few minutes and counts as one saved snapshot in your Boat plan.</p>
      </SettingsGroupBody>
    </SettingsGroup>
  )
}

/** What the snapshot in use needs said, when no build is running: why it failed, that it is out of date, or that it was entered by hand. */
function SnapshotNotes({ snap, inUse }: { snap: SnapshotStatus; inUse: string | null }) {
  const keeps = snap.snapshot && inUse === snap.snapshot ? ` Sessions keep using ${snap.snapshot}.` : ''
  return (
    <>
      {snap.state === 'failed' && (
        <SettingsGroupBody role="alert" data-testid="snapshot-error" className="text-destructive">
          <p>
            The build failed: {snap.error}
            {/[.!?]$/.test(snap.error ?? '') ? '' : '.'}
            {keeps}
          </p>
        </SettingsGroupBody>
      )}
      {snap.managed && snap.stale && (
        <SettingsGroupBody role="status" data-testid="snapshot-stale">
          <p>An update is available: this snapshot was built with an older bridge than this app carries. Update it so new sessions use the current one. Existing sessions keep what they have.</p>
        </SettingsGroupBody>
      )}
      {inUse && !snap.managed && (
        <SettingsGroupBody role="status">
          <p>You entered this snapshot by hand. Prepare Boat can build a managed one instead.</p>
        </SettingsGroupBody>
      )}
    </>
  )
}

/** A snapshot built some other way, entered by name or share code. */
function ManualSnapshot({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const [manual, setManual] = useState(settings.baseSnapshotId ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Your own snapshot" description="A snapshot you built yourself, by its name in your Boat account or a bsh_ share code.">
      <SettingsGroup
        label="manual snapshot"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ baseSnapshotId: manual.trim() })
            setSaved(true)
          })
        }}
      >
        <SettingsInputRow
          id="base-snapshot"
          label="Base snapshot"
          aria-label="base snapshot"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="dorks-base-20260101"
          trailing={
            <Button type="submit" size="sm" variant="outline" disabled={pending || !manual.trim()}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          }
        />
        <SettingsGroupBody>
          <p>
            It must contain the bridge and tools described in{' '}
            <a href="https://github.com/handlemotion/dorks/blob/main/docs/boat.md" target="_blank" rel="noreferrer">
              docs/boat.md
            </a>
            . Only use share codes from people you trust: a snapshot's code runs with your agent tokens.
          </p>
        </SettingsGroupBody>
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

const WHO = [
  { value: 'all', label: 'Anyone' },
  { value: 'allowlist', label: 'Only these logins' },
] as const

export function SessionsPage({ settings }: { settings: Settings }) {
  return (
    <SettingsSections>
      <SleepSection current={settings.sleepMinutes} />
      <CommentPolicySection settings={settings} />
    </SettingsSections>
  )
}

function SleepSection({ current }: { current: number }) {
  const { actions } = useDorksClient()
  const [minutes, setMinutes] = useState(String(current))
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const n = Number(minutes)
  return (
    <SettingsSection title="Sleep">
      <SettingsGroup
        label="sleep after idle"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ sleepMinutes: n })
            setSaved(true)
          })
        }}
      >
        <SettingsRow
          label="Sleep after idle"
          htmlFor="sleep-minutes"
          description={
            <>
              An idle sandbox is paused after this long. Currently <span data-testid="sleep-current">{current}</span> min.
            </>
          }
          control={
            <>
              <div className="flex items-center gap-2">
                <Input id="sleep-minutes" aria-label="sleep minutes" className="w-24" type="number" min={0.05} max={1440} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                <span className="text-sm text-muted-foreground">min</span>
              </div>
              <Button type="submit" size="sm" disabled={pending || !Number.isFinite(n) || minutes.trim() === ''}>
                Save
              </Button>
            </>
          }
        />
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

function CommentPolicySection({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const policy = settings.commentPolicy
  const [mode, setMode] = useState<'all' | 'allowlist'>(policy.mode)
  const [logins, setLogins] = useState(policy.mode === 'allowlist' ? policy.logins.join('\n') : '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const list = logins
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    <SettingsSection title="Pull request comments" description="A comment on a session's pull request wakes it up and becomes its next message.">
      <SettingsGroup
        label="comment policy"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ commentPolicy: mode === 'all' ? { mode: 'all' } : { mode: 'allowlist', logins: list } })
            setSaved(true)
          })
        }}
      >
        <SettingsSelectRow label="Who can wake a session" value={mode} options={WHO} onValueChange={setMode} />
        {mode === 'allowlist' && (
          <SettingsGroupBody>
            <label htmlFor="allowed-logins">GitHub logins, one per line or comma separated. Bots by login, e.g. coderabbitai[bot].</label>
            <Textarea id="allowed-logins" aria-label="allowed logins" rows={3} value={logins} onChange={(e) => setLogins(e.target.value)} className="text-foreground" />
          </SettingsGroupBody>
        )}
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" disabled={pending || (mode === 'allowlist' && list.length === 0)}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          Comments written by the token’s own account are always ignored: they are the agent’s own.
        </SettingsGroupFooter>
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

export function VariablesPage() {
  const { actions } = useDorksClient()
  const names = useSecretNames()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const { run, pending, error } = usePending()
  return (
    <SettingsSections>
      <SettingsSection title="Shared variables" description="Environment variables for every session, on any machine. A build’s own variable with the same name wins. Values are never displayed.">
        <SettingsGroup label="secret names">
          {names?.map((n) => (
            <SettingsRow
              key={n}
              label={<code className="font-mono text-xs">{n}</code>}
              control={
                <Button type="button" variant="ghost" size="sm" aria-label={`delete ${n}`} onClick={() => void run(() => actions.deleteSecret(n))}>
                  Remove
                </Button>
              }
            />
          ))}
          {names?.length === 0 && <EmptyState figure="drawer" title="No variables yet" description="Add one below and every new session gets it." />}
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Add a variable">
        <SettingsGroup
          label="add a variable"
          onSubmit={() =>
            void run(async () => {
              await actions.setSecret(name.trim(), value)
              setName('')
              setValue('')
            })
          }
        >
          <SettingsInputRow id="secret-name" label="Name" aria-label="secret name" placeholder="NAME_IN_CAPS" value={name} onChange={(e) => setName(e.target.value)} inputClassName="font-mono" />
          <SettingsInputRow id="secret-value" label="Value" aria-label="secret value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          <SettingsGroupFooter
            action={
              <Button type="submit" size="sm" disabled={pending || !name.trim() || !value}>
                Save variable
              </Button>
            }
          >
            Stored encrypted on this machine.
          </SettingsGroupFooter>
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}

/** Desktop app only: the public https URL that Boat sandboxes use to reach this machine (the tunnel's address). */
export function PublicUrlPage({ settings }: { settings: Settings }) {
  const tunnel = window.__DORKS__?.tunnel
  const [url, setUrl] = useState(window.__DORKS__?.publicUrl ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSections>
      <SettingsSection
        title="Public URL"
        description="Boat sandboxes connect out to this address, which must forward to this machine’s bridge port. Only the bridge is exposed, never the app’s own API."
      >
        <SettingsGroup
          label="public url"
          onSubmit={() => {
            setSaved(false)
            void run(async () => {
              await setPublicUrl(url.trim() || null)
              setSaved(true)
            })
          }}
        >
          <SettingsValueRow
            label="Status"
            valueTestId="tunnel-status"
            value={settings.publicUrlConfigured ? 'A public URL is set' : 'No public URL yet'}
            tone={settings.publicUrlConfigured ? 'success' : 'muted'}
            description={tunnel ? `Tunnel: ${tunnel.kind}, ${tunnel.state}${tunnel.error ? ` (${tunnel.error})` : ''}.` : undefined}
          />
          <SettingsInputRow
            id="public-url"
            label="Address"
            aria-label="public url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://dorks.example.com"
            trailing={
              <Button type="submit" size="sm" disabled={pending || !isDesktop()}>
                {pending ? 'Saving…' : 'Save and restart'}
              </Button>
            }
          />
        </SettingsGroup>
        <SettingsStatus saved={saved} error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}
