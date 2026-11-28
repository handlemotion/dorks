import { useState } from 'react'
import { CircleCheckIcon, CircleIcon } from 'lucide-react'
import type { Settings, SnapshotStatus } from '@dorks/client'
import { useDorksClient, useSecretNames, useSnapshot } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { Switch } from '@dorks/ui/switch'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../EmptyState'
import { HERE } from '../LocationMenu'
import { saveBoat } from '../../lib/boat'
import { openExternal } from '../../lib/desktop'
import { STEPS, stepDone } from '../../lib/onboarding'
import { usePending } from '../../lib/pending'
import { StepProgress } from '../StepProgress'
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
// from, how sessions behave, and the variables they all get.

export function SetupPage({ settings }: { settings: Settings }) {
  const done = stepDone(settings)
  const rows = STEPS.map((s) => ({ id: s.id, title: s.title, done: done[s.id] }))
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
  const oauth = settings.boatOAuth
  const keySaved = oauth ? (oauth.keySaved ?? (settings.boatKey && !oauth.connected)) : settings.boatKey
  return (
    <SettingsSections>
      {oauth && <BoatSignInSection oauth={oauth} />}
      <SettingsSection title={oauth ? 'API key' : 'Account'} description={oauth ? 'Instead of signing in, or as a fallback.' : undefined}>
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
            description={keySaved ? 'Saved' : 'Not set'}
            aria-label="boat api key"
            type="password"
            autoComplete="off"
            placeholder={keySaved ? 'Replace the key' : 'boat_…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <SettingsInputRow
            id="boat-org"
            label="Organization"
            description="Optional"
            aria-label="boat organization"
            autoComplete="off"
            placeholder="Personal wallet"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
          <SettingsGroupFooter
            action={
              <Button type="submit" size="sm" disabled={pending || (!key && !keySaved)}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            }
          >
            Needs access to create, use and delete sandboxes.
          </SettingsGroupFooter>
        </SettingsGroup>
        <SettingsStatus saved={saved} error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}

/**
 * A Dorks Teams org's Sign in with Boat (Boat's OAuth, through the Worker): Connect opens Boat's consent page in the browser, and the
 * Worker's callback updates the settings live. Disconnect revokes Dorks' grant at Boat; a saved key below stays.
 */
function BoatSignInSection({ oauth }: { oauth: NonNullable<Settings['boatOAuth']> }) {
  const { actions } = useDorksClient()
  const [waiting, setWaiting] = useState(false)
  const { run, pending, error } = usePending()
  const connect = () =>
    void run(async () => {
      const state = await actions.signInBoat()
      if (state?.url) {
        openExternal(state.url)
        setWaiting(true)
      }
    })
  const description = oauth.connected
    ? 'Sessions run in your Boat account. You can also disconnect Dorks in Boat’s OAuth apps.'
    : waiting
      ? 'Finish signing in in your browser.'
      : oauth.available
        ? 'Sign in to Boat and choose what Dorks can use. No key to copy.'
        : 'Not available on this server yet. Add an API key below.'
  return (
    <SettingsSection title="Sign in with Boat">
      <SettingsGroup label="sign in with boat">
        <SettingsRow
          label="Boat account"
          description={description}
          control={
            oauth.connected ? (
              <>
                <span className={`text-sm ${SETTINGS_TONE.success}`}>Connected</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      setWaiting(false)
                      await actions.signOutBoat()
                    })
                  }
                >
                  {pending ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" disabled={pending || !oauth.available} onClick={connect}>
                {pending ? 'Opening…' : waiting ? 'Open again' : 'Connect'}
              </Button>
            )
          }
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}

/**
 * Sentry, for automations' Sentry triggers: a personal token (write-only, checked with Sentry on save), the organization, and a
 * self-hosted Sentry's URL. Disconnect clears the token.
 */
export function SentryPage({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const sentry = settings.sentry ?? { connected: false, org: null, url: null }
  const [token, setToken] = useState('')
  const [org, setOrg] = useState(sentry.org ?? '')
  const [url, setUrl] = useState(sentry.url ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSections>
      <SettingsSection title="Account" description="Automations watch your Sentry projects with it.">
        <SettingsGroup
          label="sentry account"
          onSubmit={() => {
            setSaved(false)
            void run(async () => {
              await actions.updateSettings({ ...(token.trim() ? { sentryToken: token.trim() } : {}), sentryOrg: org.trim(), sentryUrl: url.trim() })
              setToken('')
              setSaved(true)
            })
          }}
        >
          <SettingsInputRow
            id="sentry-token"
            label="Auth token"
            description={sentry.connected ? 'Saved' : 'Not set'}
            aria-label="sentry auth token"
            type="password"
            autoComplete="off"
            placeholder={sentry.connected ? 'Replace the token' : 'sntryu_…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <SettingsInputRow
            id="sentry-org"
            label="Organization"
            description="Its slug, as in its Sentry URL"
            aria-label="sentry organization"
            autoComplete="off"
            placeholder="my-company"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
          <SettingsInputRow
            id="sentry-url"
            label="Sentry URL"
            description="Self-hosted only"
            aria-label="sentry url"
            autoComplete="off"
            placeholder="https://sentry.io"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <SettingsGroupFooter
            action={
              <>
                {sentry.connected && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        setSaved(false)
                        await actions.updateSettings({ sentryToken: '' })
                        setSaved(true)
                      })
                    }
                  >
                    Disconnect
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={pending || !org.trim() || (!token.trim() && !sentry.connected)}>
                  {pending ? 'Saving…' : 'Save'}
                </Button>
              </>
            }
          >
            A personal token with org:read, project:read and event:read.
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
      <SettingsSection title="Base snapshot" description="What every session starts from.">
        {!snap ? (
          <SettingsGroup>
            <SettingsGroupBody role="status">
              <p>Checking…</p>
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
        description={inUse ? <code data-testid="snapshot-in-use">{inUse}</code> : undefined}
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
          <StepProgress step={snap.stepIndex + 1} of={snap.stepCount} label="build progress" />
        </SettingsGroupBody>
      )}
      {!building && <SnapshotNotes snap={snap} inUse={inUse} />}
      {blocked && snap.cannotBuildReason && (
        <SettingsGroupBody role="status">
          <p>{snap.cannotBuildReason}</p>
        </SettingsGroupBody>
      )}
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
          <p>Built with an older bridge. Running sessions keep theirs.</p>
        </SettingsGroupBody>
      )}
      {inUse && !snap.managed && (
        <SettingsGroupBody role="status">
          <p>Entered by hand.</p>
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
    <SettingsSection title="Your own snapshot" description="A name or bsh_ share code.">
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
            Only from people you trust: it runs with your tokens.{' '}
            <a href="https://github.com/handlemotion/dorks/blob/main/docs/boat.md" target="_blank" rel="noreferrer">
              What it needs
            </a>
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
      {settings.local?.available && <LocationSection local={settings.defaultLocation === 'local'} />}
      <CodeModeSection on={settings.claudeCodeMode ?? true} />
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
          description="Cloud sessions only. Local sessions stay awake until archived."
          htmlFor="sleep-minutes"
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

/** Where new sessions start (docs/local-dorks.md): the composer's Cloud / Local choice, remembered; each session can still pick. */
function LocationSection({ local }: { local: boolean }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Where sessions run">
      <SettingsGroup>
        <SettingsRow
          label={`Start on ${HERE}`}
          htmlFor="default-local"
          description="New sessions start Local: the agent runs your own CLIs here, unsandboxed, in a worktree of the repository. The message box can switch each one to Cloud."
          control={<Switch id="default-local" checked={local} disabled={pending} onCheckedChange={(v) => void run(() => actions.updateSettings({ defaultLocation: v ? 'local' : 'cloud' }))} />}
        />
      </SettingsGroup>
      <SettingsStatus saved={false} error={error} />
    </SettingsSection>
  )
}

function CodeModeSection({ on }: { on: boolean }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Claude">
      <SettingsGroup>
        <SettingsRow
          label="Code Mode"
          htmlFor="code-mode"
          description="Claude writes code that makes several tool calls in one step. Applies to new sessions; started ones keep theirs."
          control={<Switch id="code-mode" checked={on} disabled={pending} onCheckedChange={(v) => void run(() => actions.updateSettings({ claudeCodeMode: v }))} />}
        />
      </SettingsGroup>
      <SettingsStatus saved={false} error={error} />
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
    <SettingsSection title="Pull request comments" description="A comment wakes the session.">
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
            <label htmlFor="allowed-logins">GitHub logins, one per line</label>
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
          The agent's own comments never count.
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
      <SettingsSection title="Shared variables" description="Every session gets these.">
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
          {names?.length === 0 && <EmptyState figure="drawer" title="No variables yet" />}
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
          />
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}
