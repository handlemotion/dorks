import { useState } from 'react'
import { BookOpenIcon, ExternalLinkIcon, ServerIcon } from 'lucide-react'
import type { McpServerView, SkillView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { toast } from 'sonner'
import type { Connector } from '../connectors'
import { SettingsGroup, SettingsSection, SettingsSections, SettingsValueRow, StatusDot } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { ago } from '../../lib/time'
import { ConnectorIcon, signInMcp } from './PluginsDialogs'
import type { InstalledItem } from './PluginsNav'

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Focused management view for an item selected from the Installed group in the second navbar. */
export function InstalledDetail({ item, onManageConnector, onEditServer, onRemoved }: { item: InstalledItem; onManageConnector: () => void; onEditServer: () => void; onRemoved: () => void }) {
  if (item.kind === 'connector') return <ConnectorDetail connector={item.connector} onManage={onManageConnector} onRemoved={onRemoved} />
  if (item.kind === 'server') return <ServerDetail server={item.server} onEdit={onEditServer} onRemoved={onRemoved} />
  return <SkillDetail skill={item.skill} onRemoved={onRemoved} />
}

function ConnectorDetail({ connector: c, onManage, onRemoved }: { connector: Connector; onManage: () => void; onRemoved: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <SettingsSections>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04]">
                <ConnectorIcon connector={c} className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-medium text-foreground">{c.name}</h2>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone="success" />
                    Installed
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{c.description}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="outline" onClick={onManage}>
                {c.toolkit ? 'Manage' : 'Replace key'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    if (c.toolkit) await actions.composioUnlink(c.toolkit)
                    else await actions.deleteMcpServer(c.id)
                    toast.success(`Uninstalled ${c.name}`)
                    onRemoved()
                  })
                }
              >
                Uninstall
              </Button>
            </div>
          </div>

          <SettingsSection title="Details">
            <SettingsGroup label={`${c.name} details`}>
              <SettingsValueRow label="Provider" value={c.by} />
              <SettingsValueRow label="Authentication" value={c.toolkit !== undefined ? 'OAuth via Composio' : c.keyLabel} />
              <SettingsValueRow label="Tool prefix" value={c.toolkit ? 'mcp__composio__*' : `mcp__${c.id}__*`} mono />
              <SettingsValueRow label="Availability" value="Shared by every session" tone="muted" />
            </SettingsGroup>
            {error && (
              <p role="alert" className="px-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </SettingsSection>
        </SettingsSections>
      </div>
    </div>
  )
}

function ServerDetail({ server: s, onEdit, onRemoved }: { server: McpServerView; onEdit: () => void; onRemoved: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const where = s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')
  const secrets = [...s.headerNames, ...s.envNames]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <SettingsSections>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                <ServerIcon className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-mono text-sm font-medium text-foreground">{s.name}</h2>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone={s.oauth === 'signed_out' ? 'warning' : 'success'} />
                    {s.oauth === 'signed_out' ? 'Sign in required' : 'Installed'}
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{where}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {s.oauth === 'signed_out' && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => signInMcp(actions, s.name))}>
                  Sign in
                </Button>
              )}
              {s.oauth === 'signed_in' && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => actions.mcpSignOut(s.name))}>
                  Sign out
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await actions.deleteMcpServer(s.name)
                    toast.success(`Removed ${s.name}`)
                    onRemoved()
                  })
                }
              >
                Remove
              </Button>
            </div>
          </div>

          <SettingsSection title="Configuration">
            <SettingsGroup label={`${s.name} configuration`}>
              <SettingsValueRow label="Transport" value={s.transport === 'http' ? 'Remote (HTTP)' : 'Local command (stdio)'} />
              <SettingsValueRow label={s.transport === 'http' ? 'Endpoint' : 'Command'} value={where ?? '—'} mono />
              <SettingsValueRow label="Tool prefix" value={`mcp__${s.name}__*`} mono />
              <SettingsValueRow
                label={s.transport === 'http' ? 'Headers' : 'Environment'}
                value={secrets.length ? secrets.join(', ') : 'None'}
                mono={secrets.length > 0}
                tone={secrets.length ? 'default' : 'muted'}
              />
            </SettingsGroup>
            {error && (
              <p role="alert" className="px-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </SettingsSection>
        </SettingsSections>
      </div>
    </div>
  )
}

function SkillDetail({ skill: s, onRemoved }: { skill: SkillView; onRemoved: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [note, setNote] = useState('')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <SettingsSections>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">
                <BookOpenIcon className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-mono text-sm font-medium text-foreground">{s.name}</h2>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone="success" />
                    Installed
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{s.description || 'Shared across every session in ~/.claude/skills.'}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    setNote('')
                    const { updated } = await actions.updateSkill(s.name)
                    setNote(updated ? 'Updated' : 'Up to date')
                  })
                }
              >
                Update
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await actions.deleteSkill(s.name)
                    toast.success(`Removed ${s.name}`)
                    onRemoved()
                  })
                }
              >
                Remove
              </Button>
            </div>
          </div>

          <SettingsSection title="Source">
            <SettingsGroup label={`${s.name} details`}>
              <SettingsValueRow
                label="Repository"
                value={
                  <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:underline">
                    {s.source.repo}
                    {s.source.ref ? `#${s.source.ref}` : ''}
                    <ExternalLinkIcon className="size-3 text-muted-foreground" />
                  </a>
                }
              />
              {s.source.path && <SettingsValueRow label="Path" value={s.source.path} mono />}
              <SettingsValueRow label="Commit" value={s.sha.slice(0, 7)} mono />
              <SettingsValueRow label="Package" value={`${s.fileCount} ${s.fileCount === 1 ? 'file' : 'files'} · ${kb(s.bytes)}`} />
              <SettingsValueRow label="Updated" value={note || ago(s.updatedAt)} tone="muted" />
            </SettingsGroup>
            {error && (
              <p role="alert" className="px-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </SettingsSection>
        </SettingsSections>
      </div>
    </div>
  )
}
