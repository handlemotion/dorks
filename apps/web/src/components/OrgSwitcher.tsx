import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, LaptopIcon, LogInIcon, MailIcon, PlusIcon } from 'lucide-react'
import type { CloudOrg, CloudStatus } from '@dorks/client'
import { PLAN_NAMES, type PlanId } from '@dorks/shared'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { Input } from '@dorks/ui/input'
import { startCloudSignIn } from '../lib/cloudSignIn'
import { machinesOf } from '../lib/place'
import { usePending } from '../lib/pending'
import { UserAvatar } from './AccountMenu'
import { orgName, useCloudPlace, useCloudInvitations } from './CloudPlace'
import { cn } from './onboarding/Frame'
import { SIDEBAR_ROW } from './sidebarChrome'

const PERSONAL = 'personal'

/** The plan, short, beside an org in the switcher: `Dorks Teams` -> `Teams`. */
const planLabel = (plan: PlanId | null) => (plan ? PLAN_NAMES[plan].replace(/^Dorks /, '') : null)

/**
 * An org's mark, 16px: the personal org is you (your Dorks Cloud picture, else your GitHub avatar, round like the account menu's); a team is its logo, or its
 * initial, on a 4px square like GitHub owners.
 */
export function OrgMark({ org, login, className }: { org: Pick<CloudOrg, 'name' | 'logo' | 'personal'> | null; login?: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const picture = useCloudPlace()?.cloud?.user?.image
  if (!org || org.personal) return <UserAvatar login={login} src={picture} className={className} />
  const box = cn('size-4 shrink-0 overflow-hidden rounded-[4px]', className)
  if (org.logo && failed !== org.logo) return <img alt="" src={org.logo} width={16} height={16} className={cn(box, 'object-cover')} onError={() => setFailed(org.logo)} />
  return (
    <span aria-hidden className={cn(box, 'grid place-items-center bg-foreground/10 text-[10px] leading-none text-muted-foreground')}>
      {org.name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  )
}

/** The switcher with no cloud behind it (design demos): the personal place alone. */
export function StaticOrgSwitcher({ login }: { login?: string | null }) {
  return (
    <div className={`${SIDEBAR_ROW} min-w-0 flex-1 text-foreground`}>
      <OrgMark org={null} login={login} className="-mx-px" />
      <span className="min-w-0 truncate">Personal</span>
    </div>
  )
}

/**
 * The header's switcher: where you work. Your personal org first (your name), then the teams you belong to (logo, name, plan), then
 * Create organization; signed out, Personal and Sign in to Dorks Cloud. Picking an org points the whole app at the server behind it
 * (CloudPlace.tsx); which server that is, is decided inside the org, never listed here.
 */
export function OrgSwitcher({ login }: { login?: string | null }) {
  const place = useCloudPlace()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const invitations = useCloudInvitations()
  if (!place) return <StaticOrgSwitcher login={login} />
  const { cloud, places, org, personal } = place
  const signedIn = !!cloud?.user
  const current = org ?? personal
  const teams = places?.orgs.filter((o) => !o.personal) ?? []
  const name = orgName(current, cloud)
  const pick = (id: string) => {
    if (id === (current?.id ?? PERSONAL)) return
    place.chooseOrg(id === PERSONAL ? null : id)
    void navigate({ to: '/dorks', search: {} })
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger aria-label={`Switch organization, currently ${name}`} className={`${SIDEBAR_ROW} min-w-0 flex-1 text-foreground aria-expanded:bg-foreground/[0.05]`}>
          <OrgMark org={current} login={login} className="-mx-px" />
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
        </DropdownMenuTrigger>
        {/* A little wider than the sidebar's row, so long organization names fit. */}
        <DropdownMenuContent align="start" className="w-[max(calc(var(--anchor-width)+1.5rem),15rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{signedIn ? cloud.user!.email : 'Organizations'}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={current?.id ?? PERSONAL} onValueChange={(v) => pick(v as string)}>
              <OrgItem value={personal?.id ?? PERSONAL} org={personal} cloud={cloud} login={login} />
              {teams.map((t) => (
                <OrgItem key={t.id} value={t.id} org={t} cloud={cloud} login={login} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {cloud?.cloudUrl && (
            <>
              <DropdownMenuSeparator />
              {signedIn ? (
                <>
                  {invitations.length > 0 && (
                    <DropdownMenuItem onClick={() => void navigate({ to: '/settings/$page', params: { page: 'cloud' } })}>
                      <MailIcon />
                      Invitations
                      <span className="ms-auto text-xs text-muted-foreground tabular-nums">{invitations.length}</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setCreating(true)}>
                    <PlusIcon />
                    Create organization
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  onClick={() => {
                    // The browser signs in; Settings › Account says so and offers to open it again.
                    void startCloudSignIn(place.home).catch(() => {})
                    void navigate({ to: '/settings/$page', params: { page: 'cloud' } })
                  }}
                >
                  <LogInIcon />
                  Sign in to Dorks Cloud
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} onCreated={(id) => pick(id)} />
    </>
  )
}

function OrgItem({ value, org, cloud, login }: { value: string; org: CloudOrg | null; cloud: CloudStatus | undefined; login?: string | null }) {
  // Signed out the row is already named Personal; signed in it is your name, marked Personal.
  // Every workspace shows its plan (Free, Teams, Cloud): what it costs and where it runs, not whose it is.
  const trailing = !org ? null : planLabel(org.plan ?? 'local')
  return (
    <DropdownMenuRadioItem value={value} closeOnClick>
      <OrgMark org={org} login={login} />
      <span className="min-w-0 flex-1 truncate">{orgName(org, cloud)}</span>
      {trailing && <span className="shrink-0 text-xs text-muted-foreground">{trailing}</span>}
    </DropdownMenuRadioItem>
  )
}

export function CreateOrgDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const place = useCloudPlace()
  const [name, setName] = useState('')
  const { run, pending, error } = usePending()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !place) return
    void run(async () => {
      const org = await place.home.actions.cloudCreateOrg(name.trim())
      setName('')
      onOpenChange(false)
      onCreated(org.id)
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Create organization</DialogTitle>
            <DialogDescription className="text-sm leading-5">Share chats with friends or colleagues. You can invite them once it exists.</DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-2">
            <Input aria-label="Organization name" autoFocus placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Inside an org without a server Dorks runs (`kind: "hosted"`) and with more than one Mac to work on: which one the app is connected to, and Connect to another.
 * Nothing for an org with a server Dorks runs, or a single Mac.
 */
export function MachineRow() {
  const place = useCloudPlace()
  const navigate = useNavigate()
  const org = place?.org ?? null
  if (!place || !org) return null
  const { home, machines } = machinesOf(org, place.thisMacId)
  if (machines.length + (home ? 1 : 0) < 2) return null
  const current = place.target.kind === 'remote' ? place.target.server : null
  const HOME = '~home'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-label={`Connected to ${current?.name ?? 'this Mac'}`} className={`${SIDEBAR_ROW} aria-expanded:bg-foreground/[0.05]`}>
        <LaptopIcon />
        <span className="min-w-0 truncate">{current?.name ?? 'This Mac'}</span>
        <ChevronDownIcon aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[max(calc(var(--anchor-width)+1.5rem),15rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Connect to</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current?.id ?? HOME}
            onValueChange={(v) => {
              place.chooseMachine(v === HOME ? undefined : (v as string))
              void navigate({ to: '/dorks', search: {} })
            }}
          >
            {home && (
              <DropdownMenuRadioItem value={HOME} closeOnClick>
                <LaptopIcon />
                <span className="min-w-0 flex-1 truncate">This Mac</span>
              </DropdownMenuRadioItem>
            )}
            {machines.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id} disabled={!m.online} closeOnClick>
                <LaptopIcon />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {!m.online && <span className="shrink-0 text-xs text-muted-foreground">Offline</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
