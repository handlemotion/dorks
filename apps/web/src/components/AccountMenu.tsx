import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRightIcon, BookOpenIcon, BugIcon, ChartNoAxesColumnIcon, GlobeIcon, LogOutIcon, SettingsIcon, UserRoundIcon } from 'lucide-react'
import type { Usage } from '@dorks/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { CHANGELOG_URL, RELEASES, REPO_URL, type Release } from '../lib/changelog'
import { cn } from './onboarding/Frame'
import { SEND_KEY } from './Reply'
import { SIDEBAR_ROW } from './sidebarChrome'
import { fullestUsed, UsageSections, usedPercent } from './UsageMenu'

const DOCS_URL = `${REPO_URL}/tree/main/docs`
const ISSUES_URL = `${REPO_URL}/issues/new`
/** Releases listed under What's new before Full changelog. */
const RELEASES_SHOWN = 3
/** The settings shortcut as the platform writes it. */
const SETTINGS_KEY = SEND_KEY === '⌘' ? '⌘,' : 'Ctrl+,'

/** The owner's GitHub avatar, round (a person, where owners and organizations are 4px squares), or a person glyph without one. */
export function UserAvatar({ login, size = 16, className }: { login: string | null | undefined; size?: 16 | 28; className?: string }) {
  const [failed, setFailed] = useState(false)
  const box = cn('shrink-0 overflow-hidden rounded-full', className)
  if (!login || failed) {
    return (
      <span aria-hidden style={{ width: size, height: size }} className={cn(box, 'grid place-items-center bg-foreground/10 text-muted-foreground')}>
        <UserRoundIcon style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    )
  }
  return <img alt="" src={`https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`} width={size} height={size} className={box} onError={() => setFailed(true)} />
}

/** `⌘,` (Ctrl+, elsewhere) opens Settings from anywhere in the app, as in every Mac app. */
function useSettingsShortcut() {
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ',' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      void navigate({ to: '/settings' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}

/** A trailing icon in a menu row, muted (rows paint their icons in the foreground). */
const TRAILING = 'ms-auto text-muted-foreground!'

/**
 * The sidebar's foot: the owner's avatar and GitHub login, opening one menu (upwards) with who is signed in and the app's version,
 * What's new (the latest releases on a timeline, then the full changelog), then Settings (`⌘,`), Usage, Docs and Report a problem,
 * and Change server.
 */
export function AccountMenu({
  login,
  version,
  usage,
  releases = RELEASES,
  onDisconnect,
}: {
  /** The GitHub CLI's login; null when GitHub is not connected. */
  login: string | null | undefined
  /** The running app's version (the desktop shell's), when known. */
  version?: string
  usage?: Usage
  releases?: Release[]
  onDisconnect?: (() => void) | null
}) {
  useSettingsShortcut()
  const navigate = useNavigate()
  const used = usage && fullestUsed(usage, 'claude')
  const name = login ?? 'You'
  const shown = releases.slice(0, RELEASES_SHOWN)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-label="Account and help" className={`${SIDEBAR_ROW} aria-expanded:bg-foreground/[0.05] aria-expanded:text-foreground`}>
        <UserAvatar login={login} className="-mx-px" />
        <span className="min-w-0 truncate">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-[max(calc(var(--anchor-width)+1.5rem),16rem)]">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
          <UserAvatar login={login} size={28} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm leading-5">{name}</span>
            <span className="truncate text-xs leading-4 text-muted-foreground tabular-nums">{version ? `Dorks ${version}` : login ? 'GitHub' : 'GitHub not connected'}</span>
          </div>
        </div>
        <DropdownMenuSeparator />
        {shown.length > 0 && (
          <>
            <DropdownMenuGroup aria-label="What's new">
              <DropdownMenuLabel className="min-h-6 pt-1">What's new</DropdownMenuLabel>
              {shown.map((r) => (
                <DropdownMenuLinkItem key={r.version} href={r.url} target="_blank" rel="noreferrer" title={r.headline} className={JOINED}>
                  <Dot current={r.version === version} />
                  <span className="min-w-0 flex-1 truncate">{r.headline}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{r.version}</span>
                </DropdownMenuLinkItem>
              ))}
              <DropdownMenuLinkItem href={CHANGELOG_URL} target="_blank" rel="noreferrer">
                <Dot />
                Full changelog
                <GlobeIcon className={TRAILING} />
              </DropdownMenuLinkItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void navigate({ to: '/settings' })}>
            <SettingsIcon />
            Settings
            <DropdownMenuShortcut>{SETTINGS_KEY}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {usage && used !== undefined && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg:last-child]:-ml-1">
                <ChartNoAxesColumnIcon />
                Usage
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">{usedPercent(used)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-80 gap-0 p-0 text-[13px]">
                <UsageSections usage={usage} provider="claude" />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuLinkItem href={DOCS_URL} target="_blank" rel="noreferrer">
            <BookOpenIcon />
            Docs
            <ArrowUpRightIcon className={TRAILING} />
          </DropdownMenuLinkItem>
          <DropdownMenuLinkItem href={ISSUES_URL} target="_blank" rel="noreferrer">
            <BugIcon />
            Report a problem
            <ArrowUpRightIcon className={TRAILING} />
          </DropdownMenuLinkItem>
        </DropdownMenuGroup>
        {onDisconnect && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDisconnect}>
              <LogOutIcon />
              Change server
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The timeline's line: from under this row's dot to above the next one's, in the 14px icon column (8px padding + 7px), across the
 * 32px row and the 2px gap (34px between dots, less 5px each side).
 */
const JOINED = 'after:pointer-events-none after:absolute after:top-[calc(50%+5px)] after:left-[14.5px] after:h-6 after:w-px after:bg-border'

/** A release's dot on the timeline: hollow, filled for the version running now. */
function Dot({ current }: { current?: boolean }) {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <span className={cn('size-[7px] rounded-full border', current ? 'border-foreground bg-foreground' : 'border-muted-foreground/70')} />
    </span>
  )
}
