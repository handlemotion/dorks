import { useState } from 'react'
import { BoxIcon, ChevronDownIcon, FolderIcon, PlusIcon } from 'lucide-react'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandMenuInput, CommandList } from '@dorks/ui/command'
import { InputGroupButton } from '@dorks/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { OwnerAvatar, OwnerStack, ownerOf, REPO, REPO_ITEM, RepoRow, repoOwners } from './RepoAvatar'

/** A build a session can start on: it has an image and at least one repository (docs/builds.md). */
export interface EnvironmentBuild {
  id: string
  name: string
  repos: string[]
}

/** Where a new session starts: a build and its first repository, or one repository on the base machine (`buildId: null`). */
export interface Environment {
  buildId: string | null
  repo: string
}

export interface EnvironmentChoice {
  builds: EnvironmentBuild[]
  /** Repositories to offer on the base machine; the ones inside a build are offered through it. */
  repositories: string[]
  value: Environment
  onChange: (env: Environment) => void
}

/** A repository's environment: the build that holds it, else the base machine. Repos and builds are tied, so picking one picks the other. */
export function environmentOf(builds: EnvironmentBuild[], repo: string): Environment {
  const lower = repo.toLowerCase()
  const build = builds.find((b) => b.repos.some((r) => r.toLowerCase() === lower))
  return { buildId: build?.id ?? null, repo: build ? (build.repos.find((r) => r.toLowerCase() === lower) ?? repo) : repo }
}

/** A build's mark: its repositories' owners stacked, or a box for a build with none. */
function BuildMark({ build, ring }: { build: EnvironmentBuild; ring?: string }) {
  const owners = repoOwners(build.repos)
  return owners.length ? <OwnerStack owners={owners} ring={ring} /> : <BoxIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

/** The name part of a repository. */
const nameOf = (repo: string) => repo.slice(ownerOf(repo).length + 1)

/**
 * The one chooser for a new session: the builds (their name and their repositories' owners), then the other repositories, which start
 * on the base machine. A build starts the session in its first repository. Searching matches build names and every repository in them;
 * typing a full `owner/repo` that is not listed offers it too, since a first session may name any repository.
 */
export function EnvironmentPicker({ choice, disabled }: { choice: EnvironmentChoice; disabled?: boolean }) {
  const { builds, repositories, value, onChange } = choice
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const choose = (env: Environment) => {
    onChange(env)
    setOpen(false)
  }
  const build = builds.find((b) => b.id === value.buildId)
  const inBuild = new Set(builds.flatMap((b) => b.repos.map((r) => r.toLowerCase())))
  const q = query.trim().toLowerCase()
  const shownBuilds = builds.filter((b) => !q || b.name.toLowerCase().includes(q) || b.repos.some((r) => r.toLowerCase().includes(q)))
  // The chosen base-machine repository first, then the rest; never one a build holds.
  const base = [...new Set([...(build ? [] : [value.repo].filter(Boolean)), ...repositories])].filter((r) => !inBuild.has(r.toLowerCase()) && (!q || r.toLowerCase().includes(q)))
  const typed = query.trim()
  const known = (r: string) => inBuild.has(r.toLowerCase()) || repositories.some((x) => x.toLowerCase() === r.toLowerCase()) || r.toLowerCase() === value.repo.toLowerCase()
  const canUseTyped = REPO.test(typed) && !known(typed)
  const label = build ? build.name : value.repo || 'Choose repository'
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            className="h-7 min-w-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
            aria-label={`Environment: ${label}`}
            title={build ? build.repos.join(', ') : value.repo}
            data-testid="environment"
          />
        }
      >
        {build ? <BuildMark build={build} /> : value.repo ? <OwnerAvatar owner={ownerOf(value.repo)} size={16} className="size-3.5" /> : <FolderIcon />}
        <span className="max-w-48 truncate">{label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      {/* Styled as the app's dropdown menus (hairline, soft shadow, 32px rows), since that is what it is. */}
      <PopoverContent align="start" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 ring-0`}>
        <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
          <CommandMenuInput
            aria-label="Search builds and repositories"
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={builds.length ? 'Search builds and repositories…' : 'Search repositories…'}
          />
          <CommandList className="max-h-80">
            <CommandEmpty className="px-3 py-3 text-left text-xs text-muted-foreground">
              {typed ? 'Nothing matches. Type a full owner/repo to use it.' : 'No repositories yet. Type an owner/repo.'}
            </CommandEmpty>
            {canUseTyped && (
              <CommandGroup className="p-1">
                <CommandItem value={`use:${typed}`} onSelect={() => choose({ buildId: null, repo: typed })} className={REPO_ITEM}>
                  <PlusIcon className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Use {typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {shownBuilds.length > 0 && (
              <CommandGroup heading="Builds" className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5">
                {shownBuilds.map((b) => (
                  <CommandItem
                    key={b.id}
                    value={`build:${b.id}`}
                    data-checked={b.id === value.buildId ? 'true' : undefined}
                    onSelect={() => choose({ buildId: b.id, repo: b.repos[0] ?? '' })}
                    className={REPO_ITEM}
                    title={b.repos.join(', ')}
                  >
                    <BuildMark build={b} ring="ring-popover" />
                    <span className="min-w-0 flex-1 truncate">
                      {b.name}
                      <span className="ms-2 text-muted-foreground">{b.repos.map(nameOf).join(', ')}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {base.length > 0 && (
              <CommandGroup heading={builds.length ? 'Base machine' : undefined} className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5">
                {base.map((r) => (
                  <CommandItem key={r} value={r} data-checked={!build && r === value.repo ? 'true' : undefined} onSelect={() => choose({ buildId: null, repo: r })} className={REPO_ITEM}>
                    <RepoRow repo={r} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A searchable list of repositories to pick one from (the GitHub CLI login's and the ones chats used), as the composer offers them:
 * the build page adds repositories with it. Typing a full `owner/repo` that is not listed offers it too.
 */
export function RepoCommand({ repositories, onPick }: { repositories: string[]; onPick: (repo: string) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = repositories.filter((r) => !q || r.toLowerCase().includes(q))
  const typed = query.trim()
  const canUseTyped = REPO.test(typed) && !repositories.some((r) => r.toLowerCase() === q)
  return (
    <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
      <CommandMenuInput aria-label="Search repositories" autoFocus value={query} onValueChange={setQuery} placeholder="Search repositories…" />
      <CommandList className="max-h-72 p-1">
        <CommandEmpty className="px-2 py-3 text-left text-xs text-muted-foreground">
          {typed ? 'No repositories match. Type a full owner/repo to use it.' : 'No repositories yet. Type an owner/repo.'}
        </CommandEmpty>
        {canUseTyped && (
          <CommandItem value={`use:${typed}`} onSelect={() => onPick(typed)} className={REPO_ITEM}>
            <PlusIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Use {typed}</span>
          </CommandItem>
        )}
        {shown.map((r) => (
          <CommandItem key={r} value={r} onSelect={() => onPick(r)} className={REPO_ITEM}>
            <RepoRow repo={r} />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
