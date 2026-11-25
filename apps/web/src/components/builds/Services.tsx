import { useState } from 'react'
import { ServerIcon } from 'lucide-react'
import type { BuildService, BuildView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { SettingsGroup, SettingsGroupBody, SettingsSection } from '../settings/kit'
import { ROW, RowText, Tag } from './shared'
import { ServiceDialog } from './ServiceDialog'

/** What a service row says under its name: where it runs and on which port. */
export function serviceWhere(s: BuildService) {
  return `~/work${s.cwd ? `/${s.cwd}` : ''}${s.port ? ` · port ${s.port}` : ''}`
}

export function Services({ build }: { build: BuildView }) {
  const [editing, setEditing] = useState<BuildService | 'new' | null>(null)
  return (
    <SettingsSection
      title="Services"
      description="Dev servers and backing services. The build starts each one once and warms its caches; agents start them when they test a change."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
          Add service
        </Button>
      }
    >
      <SettingsGroup label="services">
        {build.services.length === 0 && <SettingsGroupBody>No services yet. Add the dev server so agents can test changes against it right away.</SettingsGroupBody>}
        {build.services.map((s) => (
          <div key={s.name} className={ROW}>
            <ServerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <RowText
              title={
                <>
                  <span className="font-mono text-xs">{s.name}</span> <code className="font-mono text-xs text-muted-foreground">{s.command}</code>
                </>
              }
              description={serviceWhere(s)}
            />
            {s.preview && <Tag>Preview</Tag>}
            <Button size="sm" variant="ghost" aria-label={`edit ${s.name}`} onClick={() => setEditing(s)}>
              Edit
            </Button>
          </div>
        ))}
      </SettingsGroup>
      {editing && <ServiceDialog build={build} service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </SettingsSection>
  )
}
