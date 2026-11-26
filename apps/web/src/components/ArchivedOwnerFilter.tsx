import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import githubDark from '../assets/providers/github-dark.svg'
import githubLight from '../assets/providers/github-light.svg'
import { Logo } from './onboarding/List'
import { OwnerAvatar } from './RepoAvatar'

const ALL = ''

/**
 * The archived sessions' GitHub owner filter (ownerScope.ts): All owners, or one GitHub user or organization, as a small menu under the
 * list's title. Shown only when the archived sessions span two owners or more, or one is picked.
 */
export function ArchivedOwnerFilter({ owners, scope, setScope }: { owners: string[]; scope: string; setScope: (scope: string) => void }) {
  if (owners.length < 2 && !scope) return null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`Filter archived sessions by GitHub owner, currently ${scope || 'all owners'}`} />}>
        {scope ? <OwnerAvatar owner={scope} size={16} /> : <Logo light={githubLight} dark={githubDark} className="size-4 shrink-0" />}
        {scope || 'All owners'}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>GitHub owner</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={scope} onValueChange={(value) => setScope(value as string)}>
            <DropdownMenuRadioItem value={ALL} closeOnClick>
              <Logo light={githubLight} dark={githubDark} className="-mx-px size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">All owners</span>
            </DropdownMenuRadioItem>
            {owners.map((owner) => (
              <DropdownMenuRadioItem key={owner} value={owner} closeOnClick>
                <OwnerAvatar owner={owner} />
                <span className="min-w-0 flex-1 truncate">{owner}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
