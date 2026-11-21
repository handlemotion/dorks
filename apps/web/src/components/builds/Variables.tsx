import { useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildVarView, BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { SettingsGroup, SettingsGroupBody, SettingsSection, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { Tag, ROW } from './shared'
import { VarDialog } from './VarDialog'

export function Variables({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [adding, setAdding] = useState(false)
  const [filling, setFilling] = useState<BuildVarView | null>(null)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Variables"
      description="Set in every session on this machine. Mark one as needed while building to also give it to the setup script. Secret values are never shown."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          Add variable
        </Button>
      }
    >
      <SettingsGroup label="variables">
        {build.vars.length === 0 && <SettingsGroupBody>No variables yet.</SettingsGroupBody>}
        {build.vars.map((v) => (
          <div key={v.name} className={cn(ROW, 'flex-wrap md:flex-nowrap')}>
            <code className="w-56 shrink-0 truncate font-mono text-xs">{v.name}</code>
            <span className={cn('min-w-0 flex-1 truncate', v.requested ? 'text-xs text-amber-700 dark:text-amber-400' : v.secret ? 'font-mono text-xs text-muted-foreground' : 'font-mono text-xs')}>
              {v.requested ? 'Waiting for a value' : v.secret ? '••••••••••••' : v.value || '(empty)'}
            </span>
            {v.secret && <Tag>Secret</Tag>}
            {v.buildTime && <Tag>Build time</Tag>}
            <Button size="sm" variant={v.requested ? 'outline' : 'ghost'} disabled={pending} onClick={() => setFilling(v)}>
              {v.requested ? 'Fill in' : v.secret ? 'Replace' : 'Edit'}
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={pending} aria-label={`remove ${v.name}`} onClick={() => void run(() => actions.deleteBuildVar(build.id, v.name))}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </SettingsGroup>
      <SettingsStatus error={error} />
      {adding && <VarDialog build={build} onClose={() => setAdding(false)} />}
      {filling && <VarDialog build={build} variable={filling} onClose={() => setFilling(null)} />}
    </SettingsSection>
  )
}
