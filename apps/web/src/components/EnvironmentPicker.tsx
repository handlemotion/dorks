import { useState } from 'react'
import { BoxIcon, ChevronDownIcon, ExternalLinkIcon, FolderIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { cn } from 'cn'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandMenuInput, CommandList, CommandSeparator } from '@dorks/ui/command'
import { InputGroupButton } from '@dorks/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { OwnerAvatar, OwnerStack, ownerOf, REPO, REPO_ITEM, RepoRow, repoOwners } from './RepoAvatar'
import { EmptyState } from './EmptyState'
import { openExternal } from '../lib/desktop'
import { connectGithub, manageUrlOf, useCloudGithub, type CloudGithub } from '../lib/githubApp'

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

/**
 * Refresh at the end of a repository search row: the list is the GitHub CLI login's repositories, cached briefly by the server, so a
 * repository made a moment ago shows only after reading GitHub again.
 */
export function RefreshRepositories() {
  const { actions } = useDorksClient()
  const [busy, setBusy] = useState(false)
  const refresh = () => {
    setBusy(true)
    void actions.refreshGithub().finally(() => setBusy(false))
  }
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="-me-1.5 shrink-0 text-muted-foreground hover:text-foreground"
      disabled={busy}
      onClick={refresh}
      // cmdk's Command handles Enter on any descendant by selecting the highlighted item; keep it to this button's own click.
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.stopPropagation()
      }}
      aria-label="Refresh repositories from GitHub"
      title="Refresh from GitHub"
    >
      <RefreshCwIcon className={cn('size-3.5', busy && 'animate-spin')} />
    </Button>
  )
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
  // A cloud org lists what its Dorks Agents installation reaches: with nothing to list yet, how to get repositories there.
  const github = useCloudGithub()
  const listed = shownBuilds.length + base.length
  const showEmpty = !typed && !listed && !!github?.connection
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
            end={<RefreshRepositories />}
          />
          {showEmpty ? (
            <CloudGithubEmpty github={github} onOpen={() => setOpen(false)} />
          ) : (
            <CommandList className="max-h-80">
              <CommandEmpty className="px-3 py-3 text-left text-xs text-muted-foreground">
                {typed ? 'Nothing matches. Type a full owner/repo to use it, or refresh the list.' : 'No repositories yet. Type an owner/repo.'}
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
              {github && <CloudGithubFooter github={github} hidden={!!typed} separated={listed > 0} onClose={() => setOpen(false)} />}
            </CommandList>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** What a cloud org's picker offers for more repositories: add them in the installation's settings, or install the app first. */
function cloudGithubAction(github: CloudGithub, actions: ReturnType<typeof useDorksClient>['actions']): { label: string; run: () => void } | null {
  const manage = manageUrlOf(github.connection)
  if (manage) return { label: 'Add repositories on GitHub', run: () => openExternal(manage) }
  if (github.connection?.configured && github.admin) return { label: 'Connect GitHub', run: () => void connectGithub(actions, 'new') }
  return null
}

/** At the end of a cloud org's list: where more repositories come from. */
function CloudGithubFooter({ github, hidden, separated, onClose }: { github: CloudGithub; hidden: boolean; separated: boolean; onClose: () => void }) {
  const { actions } = useDorksClient()
  const action = cloudGithubAction(github, actions)
  if (!action || hidden) return null
  return (
    <>
      {separated && <CommandSeparator />}
      <CommandGroup className="p-1">
        <CommandItem
          value="github:more"
          onSelect={() => {
            onClose()
            action.run()
          }}
          className={cn(REPO_ITEM, 'text-muted-foreground')}
        >
          <ExternalLinkIcon className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{action.label}</span>
        </CommandItem>
      </CommandGroup>
    </>
  )
}

/**
 * The picker of a cloud org with no repositories to offer: the Dorks Agents app is not installed (Connect GitHub, for an owner or
 * admin), or its installation reaches none (Add repositories on GitHub, in its settings there).
 */
function CloudGithubEmpty({ github, onOpen }: { github: CloudGithub; onOpen: () => void }) {
  const { actions } = useDorksClient()
  const manage = manageUrlOf(github.connection)
  if (manage)
    return (
      <EmptyState figure="drawer" title="No repositories yet" description="Pick the repositories Dorks Agents may work in on GitHub.">
        <Button size="sm" variant="outline" onClick={() => (onOpen(), openExternal(manage))}>
          Add repositories on GitHub
        </Button>
      </EmptyState>
    )
  if (!github.connection?.configured) return <EmptyState figure="plug" title="GitHub isn’t available" description="This Dorks Cloud server has no GitHub app yet." />
  if (!github.admin) return <EmptyState figure="plug" title="GitHub isn’t connected" description="Ask an owner or admin to connect GitHub." />
  return (
    <EmptyState figure="plug" title="GitHub isn’t connected" description="Install Dorks Agents on GitHub and pick the repositories sessions work in.">
      <Button size="sm" variant="outline" onClick={() => (onOpen(), void connectGithub(actions, 'new'))}>
        Connect GitHub
      </Button>
    </EmptyState>
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
      <CommandMenuInput aria-label="Search repositories" autoFocus value={query} onValueChange={setQuery} placeholder="Search repositories…" end={<RefreshRepositories />} />
      <CommandList className="max-h-72 p-1">
        <CommandEmpty className="px-2 py-3 text-left text-xs text-muted-foreground">
          {typed ? 'No repositories match. Type a full owner/repo to use it, or refresh the list.' : 'No repositories yet. Type an owner/repo.'}
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
