import type { LocalSession, Settings } from '@dorks/client'
import { useDorksClient, useLocalAccess } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Switch } from '@dorks/ui/switch'
import { usePending } from '../../lib/pending'
import { EmptyState } from '../EmptyState'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus } from './kit'

// Your computer (docs/local-access.md): whether agents may ask to use this computer, whether every session may without asking
// (Always allow, also set from a chat's access card), and the sessions allowed from the chat. Turning access off ends all of it.

const MODES = [
  { value: 'ask', label: 'Ask once per session' },
  { value: 'off', label: 'Off' },
] as const

export function ComputerPage({ settings }: { settings: Settings }) {
  const access = useLocalAccess()
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  if (!access) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  const always = access.enabled && !!settings.localAlwaysAllow
  return (
    <SettingsSections>
      <SettingsSection title="Access" description="For CLIs and files that only exist here.">
        <SettingsGroup>
          <SettingsSelectRow
            label="Agents can ask"
            description={access.enabled ? 'A session asks once, then runs what it needs as you.' : 'Agents cannot ask.'}
            value={access.enabled ? 'ask' : 'off'}
            options={MODES}
            onValueChange={(v) => void run(() => actions.setLocalAccess(v === 'ask'))}
          />
          <SettingsRow
            label="Allow sessions to access this computer without asking"
            htmlFor="local-always-allow"
            description={always ? 'No session asks. Turn off to have each session ask again.' : 'Each session asks the first time it needs this computer.'}
            control={<Switch id="local-always-allow" checked={always} disabled={pending || !access.enabled} onCheckedChange={(v) => void run(() => actions.updateSettings({ localAlwaysAllow: v }))} />}
          />
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
      <SettingsSection
        title="Allowed sessions"
        actions={
          access.sessions.length > 1 ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.revokeLocalSessions())}>
              Stop all
            </Button>
          ) : undefined
        }
      >
        {access.sessions.length ? (
          <SettingsGroup>
            {access.sessions.map((s) => (
              <SessionRow key={s.dorkId} session={s} />
            ))}
          </SettingsGroup>
        ) : (
          <EmptyState figure="laptop" title="No sessions allowed" description="Sessions you allow from the chat show here." />
        )}
      </SettingsSection>
    </SettingsSections>
  )
}

function SessionRow({ session }: { session: LocalSession }) {
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  return (
    <SettingsRow
      label={session.dorkTitle || 'A session'}
      description={`Allowed ${new Date(session.allowedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
      control={
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.revokeLocalSessions(session.dorkId))}>
          Stop
        </Button>
      }
    />
  )
}
