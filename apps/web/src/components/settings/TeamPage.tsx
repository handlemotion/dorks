import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon } from 'lucide-react'
import type { CloudMember, CloudOrg, CloudOrgDetail } from '@dorks/client'
import { useStoreValue } from '@dorks/client/react'
import { PLAN_NAMES, PLAN_SUMMARIES } from '@dorks/shared'
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
import { usePending } from '../../lib/pending'
import { openExternal } from '../../lib/desktop'
import { connectGithub, useCloudGithub } from '../../lib/githubApp'
import { useDorksClient } from '@dorks/client/react'
import { OwnerAvatar } from '../RepoAvatar'
import { isTeamOrg, orgName, useCloudPlace, type CloudPlace } from '../CloudPlace'
import { EmptyState } from '../EmptyState'
import { CreateOrgDialog, OrgMark } from '../OrgSwitcher'
import { isAdminRole } from './access'
import { moveTargets, MoveIntoTeam, showsWhereItRuns, WhereItRuns } from './MoveToCloud'
import { SettingsGroup, SettingsGroupFooter, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus } from './kit'

// Settings › Organization: the Dorks Cloud org you work in now (the sidebar switcher's), through Better Auth's organization endpoints
// on the relay (the local server forwards them with your session). Everyone sees the members; admins invite, change roles, remove and
// cancel invitations; owners rename it, change its logo and delete it. A personal org has only you.

const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
] as const

/** The strongest of a comma list of roles. */
const strongest = (role: string | null | undefined) => {
  const roles = (role ?? '').split(',').map((r) => r.trim())
  return roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : 'member'
}
const roleLabel = (role: string) => strongest(role).replace(/^./, (c) => c.toUpperCase())

export function TeamPage() {
  const place = useCloudPlace()
  const navigate = useNavigate()
  if (!place?.cloud?.user)
    return (
      <EmptyState figure="cabinet" title="Not signed in to Dorks Cloud" description="Organizations share chats and servers with the people in them.">
        <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/settings/$page', params: { page: 'cloud' } })}>
          Sign in
        </Button>
      </EmptyState>
    )
  const org = place.org ?? place.personal
  if (!org) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  return <Team key={org.id} place={place} org={org} />
}

function Team({ place, org }: { place: CloudPlace; org: CloudOrg }) {
  const detail = useStoreValue(place.home.cloudOrg(org.id)).data
  // The org this computer's server belongs to: only that one can move from here to the cloud.
  const serverOrg = useStoreValue(place.home.me()).data?.serverOrg
  const me = place.cloud!.user!
  const role = strongest(org.role)
  const admin = isAdminRole(role)
  const targets = moveTargets(place, org, serverOrg)
  return (
    <SettingsSections>
      <About place={place} org={org} owner={role === 'owner'} />
      {/* Members, roles, invitations and leaving are team things (isTeamOrg): a personal org has only you. */}
      {!isTeamOrg(org) && <Personal />}
      {showsWhereItRuns(org, serverOrg) && <WhereItRuns place={place} org={org} admin={admin} />}
      {targets.length > 0 && <MoveIntoTeam place={place} targets={targets} />}
      {place.target.kind === 'cloud' && place.target.org.id === org.id && <Github />}
      {isTeamOrg(org) && <Members place={place} org={org} detail={detail} meId={me.id} myRole={role} />}
      {admin && isTeamOrg(org) && <Invite place={place} org={org} detail={detail} />}
      {isTeamOrg(org) && <Leave place={place} org={org} owner={role === 'owner'} />}
    </SettingsSections>
  )
}

function About({ place, org, owner }: { place: CloudPlace; org: CloudOrg; owner: boolean }) {
  const [name, setName] = useState(org.name)
  const [logo, setLogo] = useState(org.logo ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  // The plan and what it gives; the personal org is always yours, on Dorks Local unless it pays for more.
  const id = org.plan ?? 'local'
  const plan = `${org.personal ? 'Personal, ' : ''}${PLAN_NAMES[id]}. ${PLAN_SUMMARIES[id]}`
  if (!owner || org.personal)
    return (
      <SettingsSection title="Organization">
        <SettingsGroup>
          <SettingsRow label={<NameWithMark org={org} place={place} />} description={plan} />
        </SettingsGroup>
      </SettingsSection>
    )
  return (
    <SettingsSection title="Organization" description={plan}>
      <SettingsGroup
        label="organization"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await place.home.actions.cloudOrgAction('update', { organizationId: org.id, data: { name: name.trim(), logo: logo.trim() } })
            setSaved(true)
          })
        }}
      >
        <SettingsInputRow id="org-name" label="Name" aria-label="organization name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <SettingsInputRow id="org-logo" label="Logo" description="An image URL" aria-label="organization logo" placeholder="https://…" value={logo} onChange={(e) => setLogo(e.target.value)} />
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" disabled={pending || !name.trim() || (name.trim() === org.name && logo.trim() === (org.logo ?? ''))}>
              Save
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

/**
 * A cloud org's GitHub: the accounts the Dorks Agents app is installed on (each with GitHub's settings page for it, where repositories
 * are added), and for an owner or admin, installing it (GitHub's round trip comes back here).
 */
function Github() {
  const github = useCloudGithub()
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  if (!github) return null
  const installations = github.connection?.installations ?? []
  const connect = () => void run(() => connectGithub(actions, 'settings'))
  return (
    <SettingsSection title="GitHub" description="Sessions work in the repositories the Dorks Agents app can reach.">
      <SettingsGroup label="github">
        {installations.map((i) => (
          <SettingsRow
            key={i.id}
            label={
              <span className="inline-flex items-center gap-2">
                <OwnerAvatar owner={i.account} />
                {i.account}
              </span>
            }
            description={`${i.accountType === 'Organization' ? 'Organization' : 'Account'} · ${i.suspended ? 'Suspended on GitHub' : 'Connected'}`}
            control={
              i.manageUrl && (
                <Button size="sm" variant="outline" onClick={() => openExternal(i.manageUrl!)}>
                  Manage on GitHub
                </Button>
              )
            }
          />
        ))}
        {!installations.length && (
          <SettingsRow
            label="Not connected"
            description={github.connection && !github.connection.configured ? 'This Dorks Cloud server has no GitHub app yet.' : 'Install Dorks Agents on GitHub and pick its repositories.'}
          />
        )}
        {github.admin && github.connection?.configured && (
          <SettingsGroupFooter
            action={
              <Button size="sm" variant={installations.length ? 'outline' : 'default'} disabled={pending} onClick={connect}>
                {installations.length ? 'Connect another account' : 'Connect GitHub'}
              </Button>
            }
          >
            Opens GitHub in your browser, then comes back here.
          </SettingsGroupFooter>
        )}
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}

function NameWithMark({ org, place }: { org: CloudOrg; place: CloudPlace }) {
  return (
    <span className="inline-flex items-center gap-2">
      <OrgMark org={org} />
      {orgName(org, place.cloud)}
    </span>
  )
}

function Personal() {
  const [creating, setCreating] = useState(false)
  const place = useCloudPlace()!
  const navigate = useNavigate()
  return (
    <SettingsSection title="Share with others">
      <SettingsGroup>
        <SettingsRow
          label="This is your personal organization"
          description="Create an organization to share chats and servers with friends or colleagues."
          control={
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              Create organization
            </Button>
          }
        />
      </SettingsGroup>
      <CreateOrgDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          place.chooseOrg(id)
          void navigate({ to: '/settings/$page', params: { page: 'organization' }, replace: true })
        }}
      />
    </SettingsSection>
  )
}

function Members({ place, org, detail, meId, myRole }: { place: CloudPlace; org: CloudOrg; detail: CloudOrgDetail | undefined; meId: string; myRole: string }) {
  const { run, error } = usePending()
  const members = detail?.members ?? []
  // An admin manages members and admins; only an owner touches an owner.
  const canManage = (m: CloudMember) => m.userId !== meId && isAdminRole(myRole) && (strongest(m.role) !== 'owner' || myRole === 'owner')
  return (
    <SettingsSection title={detail ? `Members (${members.length})` : 'Members'}>
      <SettingsGroup label="members">
        {!detail && <SettingsRow label="Loading…" />}
        {members.map((m) => (
          <SettingsRow
            key={m.id}
            label={m.userId === meId ? `${m.user.name || m.user.email} (you)` : m.user.name || m.user.email}
            description={m.user.email}
            control={
              canManage(m) ? (
                <MemberMenu
                  member={m}
                  owner={myRole === 'owner'}
                  onRole={(role) => void run(() => place.home.actions.cloudOrgAction('update-member-role', { organizationId: org.id, memberId: m.id, role }))}
                  onRemove={() => void run(() => place.home.actions.cloudOrgAction('remove-member', { organizationId: org.id, memberIdOrEmail: m.id }))}
                />
              ) : (
                <span className="text-sm text-muted-foreground">{roleLabel(m.role)}</span>
              )
            }
          />
        ))}
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}

function MemberMenu({ member, owner, onRole, onRemove }: { member: CloudMember; owner: boolean; onRole: (role: string) => void; onRemove: () => void }) {
  const roles = owner ? [...ROLES, { value: 'owner', label: 'Owner' }] : ROLES
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label={`Role of ${member.user.name || member.user.email}`} />}>
        {roleLabel(member.role)}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Role</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={strongest(member.role)} onValueChange={(v) => onRole(v as string)}>
            {roles.map((r) => (
              <DropdownMenuRadioItem key={r.value} value={r.value} closeOnClick>
                {r.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          Remove from organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Invite({ place, org, detail }: { place: CloudPlace; org: CloudOrg; detail: CloudOrgDetail | undefined }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [sent, setSent] = useState(false)
  const { run, pending, error } = usePending()
  const cancel = usePending()
  const pendingInvites = (detail?.invitations ?? []).filter((i) => i.status === 'pending')
  return (
    <SettingsSection title="Invite" description="They get an email with a link and a code. A plan is one price for the organization; a fair-use limit caps its members.">
      <SettingsGroup
        label="invite"
        onSubmit={() => {
          setSent(false)
          void run(async () => {
            await place.home.actions.cloudOrgAction('invite-member', { organizationId: org.id, email: email.trim(), role })
            setEmail('')
            setSent(true)
          })
        }}
      >
        <SettingsInputRow id="invite-email" label="Email" aria-label="invite email" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <SettingsSelectRow label="Role" value={role} options={[...ROLES]} onValueChange={(v) => setRole(v)} />
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" disabled={pending || !email.includes('@')}>
              Invite
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus saved={sent} error={error} />
      {pendingInvites.length > 0 && (
        <SettingsGroup label="pending invitations">
          {pendingInvites.map((i) => (
            <SettingsRow
              key={i.id}
              label={i.email}
              description={`${roleLabel(i.role)} · waiting, expires ${new Date(i.expiresAt).toLocaleDateString()}`}
              control={
                <Button size="sm" variant="outline" disabled={cancel.pending} onClick={() => void cancel.run(() => place.home.actions.cloudOrgAction('cancel-invitation', { invitationId: i.id }))}>
                  Cancel
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      )}
      <SettingsStatus error={cancel.error} />
    </SettingsSection>
  )
}

function Leave({ place, org, owner }: { place: CloudPlace; org: CloudOrg; owner: boolean }) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const { run, pending, error } = usePending()
  const gone = () => {
    place.chooseOrg(null)
    void navigate({ to: '/dorks', search: {} })
  }
  return (
    <SettingsSection title="Leave">
      <SettingsGroup>
        <SettingsRow
          label="Leave organization"
          description="Its chats and servers go away from your switcher."
          control={
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(async () => (await place.home.actions.cloudOrgAction('leave', { organizationId: org.id }), gone()))}>
              Leave
            </Button>
          }
        />
        {owner && (
          <SettingsRow
            label="Delete organization"
            description="For everyone in it. Its hosted server stops."
            control={
              <Button size="sm" variant="destructive" disabled={pending} onClick={() => setDeleting(true)}>
                Delete
              </Button>
            }
          />
        )}
      </SettingsGroup>
      <SettingsStatus error={error} />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Delete {org.name}?</DialogTitle>
            <DialogDescription className="text-sm leading-5">Everyone loses access, and its hosted server stops. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await place.home.actions.cloudOrgAction('delete', { organizationId: org.id })
                  setDeleting(false)
                  gone()
                })
              }
            >
              Delete organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
