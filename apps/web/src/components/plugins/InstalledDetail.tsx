import { useState, type ReactNode } from 'react'
import { BookOpenIcon, ExternalLinkIcon, ServerIcon } from 'lucide-react'
import type { McpServerView, SkillView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { toast } from 'sonner'
import type { Connector } from '../connectors'
import { SettingsButtonRow, SettingsGroup, SettingsSection, SettingsSections, SettingsStatus, SettingsValueRow, StatusDot } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { ago } from '../../lib/time'
import { ConnectorIcon, signInMcp } from './PluginsDialogs'
import type { SelectedItem } from './PluginsNav'

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Top overview row inside SettingsGroup, matching the main Plugins list's icon + title/description alignment. */
function OverviewRow({ icon, title, description, mono, control }: { icon: ReactNode; title: string; description?: ReactNode; mono?: boolean; control?: ReactNode }) {
  return (
    <div className="flex min-h-13 w-full min-w-0 items-center gap-3 py-2.5 ps-4 pe-3 text-start">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={mono ? 'truncate font-mono text-xs leading-4 text-foreground' : 'truncate text-sm leading-4 text-foreground'}>{title}</span>
        {description && <span className="truncate text-xs leading-4 text-muted-foreground">{description}</span>}
      </div>
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  )
}

/** Focused settings-kit detail view for an installed plugin, custom server, or skill. */
export function InstalledDetail({ item, onManageConnector, onEditServer, onRemoved }: { item: SelectedItem; onManageConnector: () => void; onEditServer: () => void; onRemoved: () => void }) {
  if (item.kind === 'connector') return <ConnectorDetail connector={item.connector} onManage={onManageConnector} onRemoved={onRemoved} />
  if (item.kind === 'server') return <ServerDetail server={item.server} onEdit={onEditServer} onRemoved={onRemoved} />
  return <SkillDetail skill={item.skill} onRemoved={onRemoved} />
}

function ConnectorDetail({ connector: c, onManage, onRemoved }: { connector: Connector; onManage: () => void; onRemoved: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-16 sm:px-6">
        <SettingsSections>
          <SettingsSection title="Overview">
            <SettingsGroup label={`${c.name} overview`}>
              <OverviewRow
                icon={<ConnectorIcon connector={c} className="size-4" />}
                title={c.name}
                description={c.description}
                control={
                  <>
                    <span title="Installed" aria-label="Installed" className="flex items-center">
                      <StatusDot tone="success" />
                    </span>
                    <Button size="sm" variant="outline" onClick={onManage}>
                      {c.toolkit ? 'Manage' : 'Replace key'}
                    </Button>
                  </>
                }
              />
              <SettingsValueRow label="Provider" value={c.by} />
              <SettingsValueRow label="Authentication" value={c.toolkit !== undefined ? 'OAuth via Composio' : c.keyLabel} />
              <SettingsValueRow label="Tool prefix" value={c.toolkit ? 'mcp__composio__*' : `mcp__${c.id}__*`} mono />
              <SettingsValueRow label="Availability" value="Shared by every session" tone="muted" />
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title="Remove">
            <SettingsGroup label={`remove ${c.name}`}>
              <SettingsButtonRow
                label={`Uninstall ${c.name}`}
                description="Sessions will no longer have access to its tools."
                actionLabel="Uninstall"
                variant="outline"
                disabled={pending}
                onAction={() =>
                  void run(async () => {
                    if (c.toolkit) await actions.composioUnlink(c.toolkit)
                    else await actions.deleteMcpServer(c.id)
                    toast.success(`Uninstalled ${c.name}`)
                    onRemoved()
                  })
                }
              />
            </SettingsGroup>
            <SettingsStatus error={error} />
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
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-16 sm:px-6">
        <SettingsSections>
          <SettingsSection title="Configuration">
            <SettingsGroup label={`${s.name} configuration`}>
              <OverviewRow
                icon={<ServerIcon className="size-3.5" />}
                title={s.name}
                mono
                description={<span className="font-mono">{where}</span>}
                control={
                  <>
                    <span title={s.oauth === 'signed_out' ? 'Sign in required' : 'Installed'} aria-label={s.oauth === 'signed_out' ? 'Sign in required' : 'Installed'} className="flex items-center">
                      <StatusDot tone={s.oauth === 'signed_out' ? 'warning' : 'success'} />
                    </span>
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
                  </>
                }
              />
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
          </SettingsSection>

          <SettingsSection title="Remove">
            <SettingsGroup label={`remove ${s.name}`}>
              <SettingsButtonRow
                label={`Remove ${s.name}`}
                description="Deletes this custom plugin and its stored secrets."
                actionLabel="Remove"
                variant="outline"
                disabled={pending}
                onAction={() =>
                  void run(async () => {
                    await actions.deleteMcpServer(s.name)
                    toast.success(`Removed ${s.name}`)
                    onRemoved()
                  })
                }
              />
            </SettingsGroup>
            <SettingsStatus error={error} />
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
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-16 sm:px-6">
        <SettingsSections>
          <SettingsSection title="Source">
            <SettingsGroup label={`${s.name} details`}>
              <OverviewRow
                icon={<BookOpenIcon className="size-3.5" />}
                title={s.name}
                mono
                description={s.description || 'Shared across every session in ~/.claude/skills.'}
                control={
                  <>
                    <span title="Installed" aria-label="Installed" className="flex items-center">
                      <StatusDot tone="success" />
                    </span>
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
                  </>
                }
              />
              {s.local ? (
                <SettingsValueRow label="Folder" value={s.local} mono />
              ) : (
                <>
                  <SettingsValueRow
                    label="Repository"
                    value={
                      <a href={s.url ?? undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:underline">
                        {s.source.repo}
                        {s.source.ref ? `#${s.source.ref}` : ''}
                        <ExternalLinkIcon className="size-3 text-muted-foreground" />
                      </a>
                    }
                  />
                  {s.source.path && <SettingsValueRow label="Path" value={s.source.path} mono />}
                  <SettingsValueRow label="Commit" value={s.sha.slice(0, 7)} mono />
                </>
              )}
              <SettingsValueRow label="Package" value={`${s.fileCount} ${s.fileCount === 1 ? 'file' : 'files'} · ${kb(s.bytes)}`} />
              <SettingsValueRow label="Updated" value={note || ago(s.updatedAt)} tone="muted" />
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title="Remove">
            <SettingsGroup label={`remove ${s.name}`}>
              <SettingsButtonRow
                label={`Remove ${s.name}`}
                description="Removes this skill from future sessions."
                actionLabel="Remove"
                variant="outline"
                disabled={pending}
                onAction={() =>
                  void run(async () => {
                    await actions.deleteSkill(s.name)
                    toast.success(`Removed ${s.name}`)
                    onRemoved()
                  })
                }
              />
            </SettingsGroup>
            <SettingsStatus error={error} />
          </SettingsSection>
        </SettingsSections>
      </div>
    </div>
  )
}
