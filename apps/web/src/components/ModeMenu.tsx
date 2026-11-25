import type { ComponentType } from 'react'
import { ChevronDownIcon, CodeXmlIcon, MessageCircleIcon } from 'lucide-react'
import { DORK_MODES, MODES, type DorkMode } from '@dorks/shared'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroupButton } from '@dorks/ui/input-group'
import { DorkIcon } from './DorkIcon'

/** The session's mode (docs/modes.md) and, when it can change, how. Without `onChange` the menu only names it. */
export interface ModeChoice {
  value: DorkMode
  onChange?: (mode: DorkMode) => void
  /** Why it cannot change now (a worker's mode is its coordinator's). */
  lockedReason?: string
}

/** A nerd's mark is the dork's own, in its green (DorkIcon), the one it has in the sidebar. */
const NerdIcon = ({ className }: { className?: string }) => <DorkIcon state="working" nerd still size={14} className={className} />

export const MODE_ICONS: Record<DorkMode, ComponentType<{ className?: string }>> = { chat: MessageCircleIcon, code: CodeXmlIcon, nerd: NerdIcon }

/** The box's hint for each mode when the caller gives none. */
export const MODE_HINTS: Record<DorkMode, string> = {
  chat: 'Ask anything...',
  code: 'Ask the agent to change your code...',
  nerd: 'Give the nerd a goal to plan and delegate...',
}

/** The composer bar's first control: Chat, Code or Nerd, each with one line on what it does. */
export function ModeMenu({ mode, disabled }: { mode?: ModeChoice; disabled?: boolean }) {
  if (!mode) return null
  const Icon = MODE_ICONS[mode.value]
  const label = MODES[mode.value].label
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || !mode.onChange}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            aria-label={`Mode: ${label}`}
            title={mode.lockedReason}
            data-testid="mode"
            className="h-7 shrink-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon />
        <span>{label}</span>
        {mode.onChange && <ChevronDownIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode.value} onValueChange={(v) => mode.onChange?.(v as DorkMode)}>
            {DORK_MODES.map((m) => {
              const ItemIcon = MODE_ICONS[m]
              return (
                // Two lines: the icon and the check sit level with the title's 20px line (6px padding + 3px), not the middle of the row.
                <DropdownMenuRadioItem key={m} value={m} closeOnClick className="h-auto items-start py-1.5 [&>[data-slot=dropdown-menu-radio-item-indicator]]:top-[9px]">
                  <span className="flex h-5 items-center">
                    <ItemIcon />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span>{MODES[m].label}</span>
                    <span className="text-xs text-muted-foreground">{MODES[m].description}</span>
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
