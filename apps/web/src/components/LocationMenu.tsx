import { ChevronDownIcon, CloudIcon, LaptopIcon } from 'lucide-react'
import type { DorkLocation } from '@dorks/shared'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroupButton } from '@dorks/ui/input-group'

// Where a new session runs (docs/local-dorks.md): Cloud, its own sandbox (the default), or Local, on the owner's computer with the CLIs
// installed there. Offered only when the server says this client may (`Settings.local`): the owner, on the computer the server runs on.

/** The new session's location and how to change it; the change is remembered as the owner's default. */
export interface LocationChoice {
  value: DorkLocation
  onChange: (location: DorkLocation) => void
  /** Why Cloud cannot be picked (Dorks Free runs chats on this Mac); undefined when it can. */
  cloudBlocked?: string
}

/** "this Mac" in the desktop app; the dev web app may run elsewhere. */
export const HERE = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) ? 'this Mac' : 'this computer'

export const LOCATION_ICONS = { cloud: CloudIcon, local: LaptopIcon } as const
const NAMES: Record<DorkLocation, string> = { cloud: 'Cloud', local: 'Local' }
const DETAILS: Record<DorkLocation, string> = { cloud: 'In its own sandbox', local: `On ${HERE}, with your CLIs` }

export function LocationMenu({ choice, disabled }: { choice: LocationChoice; disabled?: boolean }) {
  const Icon = LOCATION_ICONS[choice.value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            data-testid="location-menu"
            aria-label={`Runs in: ${NAMES[choice.value]}`}
            className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon className="size-3.5" />
        <span>{NAMES[choice.value]}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={choice.value} onValueChange={(v) => choice.onChange(v as DorkLocation)}>
          {(['cloud', 'local'] as const).map((l) => {
            const ItemIcon = LOCATION_ICONS[l]
            return (
              <DropdownMenuRadioItem key={l} value={l} disabled={l === 'cloud' && !!choice.cloudBlocked}>
                <ItemIcon />
                <span>{NAMES[l]}</span>
                <span className="text-muted-foreground">{l === 'cloud' && choice.cloudBlocked ? 'Needs Teams' : DETAILS[l]}</span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Said once, where the choice is made: a local agent is not sandboxed. */}
        <p className="px-2 py-1.5 text-xs whitespace-nowrap text-muted-foreground">Local agents run unsandboxed, as you, in a worktree of the repository.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
