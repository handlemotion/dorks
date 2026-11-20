import { FileTextIcon, TerminalIcon } from 'lucide-react'
import type { LocalGrant } from '@dorks/client'
import { useDorksClient, useLocalAccess } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { usePending } from '../../lib/pending'
import { EmptyState } from '../EmptyState'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus } from './kit'

// Your computer (docs/local-access.md): whether agents may ask to run a command or read a file on this computer, and the permissions
// granted from the chat for an hour. Turning it off ends every permission and refuses what is waiting.

const MODES = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'off', label: 'Off' },
] as const

const left = (at: number) => {
  const m = Math.max(1, Math.round((at - Date.now()) / 60_000))
  return m >= 60 ? '1 hour left' : `${m} min left`
}

export function ComputerPage() {
  const access = useLocalAccess()
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  if (!access) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  return (
    <SettingsSections>
      <SettingsSection title="Access" description="Agents run in the cloud. When one needs something that only exists here, a signed-in CLI or a local file, it can ask.">
        <SettingsGroup>
          <SettingsSelectRow
            label="Agents may ask to use this computer"
            description={access.enabled ? 'You see the exact command or file in the chat and decide. Nothing runs without your answer.' : 'Agents are told it is off and cannot ask.'}
            value={access.enabled ? 'ask' : 'off'}
            options={MODES}
            onValueChange={(v) => void run(() => actions.setLocalAccess(v === 'ask'))}
          />
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
      <SettingsSection
        title="Allowed for now"
        actions={
          access.grants.length > 1 ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.revokeLocalGrants())}>
              Stop all
            </Button>
          ) : undefined
        }
      >
        {access.grants.length ? (
          <SettingsGroup>
            {access.grants.map((g) => (
              <GrantRow key={g.id} grant={g} />
            ))}
          </SettingsGroup>
        ) : (
          <EmptyState figure="laptop" title="Nothing allowed for now" description="When you allow a request for 1 hour, it shows here until it ends or you stop it." />
        )}
      </SettingsSection>
    </SettingsSections>
  )
}

function GrantRow({ grant }: { grant: LocalGrant }) {
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  const target = grant.kind === 'run' ? grant.command : `Files in ${grant.dir}`
  const where = grant.kind === 'run' ? `in ${grant.cwd} · ` : ''
  return (
    <SettingsRow
      icon={grant.kind === 'run' ? TerminalIcon : FileTextIcon}
      label={<span className="font-mono text-xs">{target}</span>}
      description={`${where}${grant.dorkTitle || 'A session'} · ${left(grant.expiresAt)}`}
      control={
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.revokeLocalGrant(grant.id))}>
          Stop
        </Button>
      }
    />
  )
}
