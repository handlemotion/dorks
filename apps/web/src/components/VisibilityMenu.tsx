import { ChevronDownIcon, LockIcon, UsersIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { InputGroupButton } from '@dorks/ui/input-group'

// Who sees a new chat in a team on Dorks Cloud: only you (the default), or the whole team. Either can change later from the chat's
// ••• menu or its right-click menu in the sidebar (lib/share.ts).

export interface VisibilityChoice {
  shared: boolean
  onChange: (shared: boolean) => void
}

const OPTIONS = [
  { value: 'private', name: 'Private', detail: 'Only you', Icon: LockIcon },
  { value: 'team', name: 'Team', detail: 'Everyone in the team', Icon: UsersIcon },
] as const

export function VisibilityMenu({ choice, disabled }: { choice: VisibilityChoice; disabled?: boolean }) {
  const current = OPTIONS[choice.shared ? 1 : 0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            data-testid="visibility-menu"
            aria-label={`Who sees it: ${current.name}`}
            className="h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <current.Icon className="size-3.5" />
        <span>{current.name}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={current.value} onValueChange={(v) => choice.onChange(v === 'team')}>
          {OPTIONS.map(({ value, name, detail, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon />
              <span>{name}</span>
              <span className="text-muted-foreground">{detail}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
