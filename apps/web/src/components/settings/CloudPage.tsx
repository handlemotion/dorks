import { useState } from 'react'
import type { CloudSession, CloudUser } from '@dorks/client'
import { useStoreValue } from '@dorks/client/react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@dorks/ui/button'
import { startCloudSignIn } from '../../lib/cloudSignIn'
import { usePending } from '../../lib/pending'
import { orgName, useCloudInvitations, useCloudPlace } from '../CloudPlace'
import { EmptyState } from '../EmptyState'
import { OrgMark } from '../OrgSwitcher'
import { SettingsGroup, SettingsGroupFooter, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsStatus, StatusDot } from './kit'
import { PictureRow } from './PictureRow'
import { initials } from '../Teammates'

// Dorks Cloud (docs/mobile.md, "Desktop: Dorks Cloud"): sign this app in with the account the phone uses, in the browser. The
// session is kept by this Mac's server (encrypted), which then lists the account's organizations for the sidebar's switcher and
// reaches their servers through the relay. Signed in, the profile is edited here (name, picture) and the account's sessions are listed
// and signed out: the browser is only for signing in and onboarding.

export function CloudPage() {
  const place = useCloudPlace()
  if (!place || !place.cloud) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  if (!place.cloud.cloudUrl) return <EmptyState figure="relay" title="Dorks Cloud is off" description="Set DORKS_CLOUD_URL to sign in." />
  return place.cloud.user ? <SignedIn /> : <SignIn />
}

function SignIn() {
  const place = useCloudPlace()!
  const [opened, setOpened] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSections>
      <SettingsSection title="Sign in to Dorks Cloud" description="Work in your organizations and on your other Macs from here. Use the account you use on your phone.">
        <SettingsGroup>
          <SettingsRow
            label="Dorks Cloud account"
            description={opened ? 'Finish signing in in your browser. This app signs in when you come back.' : 'Sign in or create an account in your browser.'}
            control={
              <Button size="sm" variant={opened ? 'outline' : 'default'} disabled={pending} onClick={() => void run(async () => (await startCloudSignIn(place.home), setOpened(true)))}>
                {opened ? 'Open again' : 'Sign in'}
              </Button>
            }
          />
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
    </SettingsSections>
  )
}

function SignedIn() {
  const place = useCloudPlace()!
  const navigate = useNavigate()
  const { run, pending, error } = usePending()
  const user = place.cloud!.user!
  const orgs = place.places?.orgs ?? []
  return (
    <SettingsSections>
      <Profile user={user} />
      <SettingsSection title="Account">
        <SettingsGroup>
          <SettingsRow
            label={user.email}
            description="Signed in on this computer"
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    place.chooseOrg(null)
                    await place.home.actions.cloudSignOut()
                  })
                }
              >
                Sign out
              </Button>
            }
          />
        </SettingsGroup>
        <SettingsStatus error={error} />
      </SettingsSection>
      <Sessions />
      <Invitations />
      {orgs.length > 0 && (
        <SettingsSection title="Organizations" description="Pick one in the sidebar's switcher to work in it.">
          <SettingsGroup>
            {orgs.map((o) => {
              const online = o.servers.filter((s) => s.online).length
              return (
                <SettingsRow
                  key={o.id}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <OrgMark org={o} />
                      {orgName(o, place.cloud)}
                    </span>
                  }
                  description={
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone={online ? 'success' : 'idle'} />
                      {[o.personal ? 'Personal' : o.role, o.servers.length ? `${online} of ${o.servers.length} servers online` : 'No servers yet'].filter(Boolean).join(' · ')}
                    </span>
                  }
                  control={
                    place.org?.id === o.id || (!place.org && o.personal) ? (
                      <span className="text-xs text-muted-foreground">In use</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          place.chooseOrg(o.id)
                          void navigate({ to: '/dorks', search: {} })
                        }}
                      >
                        Switch
                      </Button>
                    )
                  }
                />
              )
            })}
          </SettingsGroup>
        </SettingsSection>
      )}
    </SettingsSections>
  )
}

/** Your name and picture, as teammates see them on messages, in presence and in the switcher. */
function Profile({ user }: { user: CloudUser }) {
  const place = useCloudPlace()!
  const actions = place.home.actions
  const [name, setName] = useState(user.name)
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Profile" description="How you appear to the people in your organizations.">
      <SettingsGroup
        label="profile"
        onSubmit={() => {
          setSaved(false)
          void run(async () => (await actions.cloudRename(name.trim()), setSaved(true)))
        }}
      >
        <PictureRow
          label="Picture"
          shape="round"
          image={user.image}
          fallback={initials(user.name || user.email)}
          onUpload={(p) => actions.cloudSetAvatar(p)}
          onRemove={() => actions.cloudRemoveAvatar()}
        />
        <SettingsInputRow id="account-name" label="Name" aria-label="your name" value={name} maxLength={80} autoComplete="name" onChange={(e) => (setName(e.target.value), setSaved(false))} />
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" disabled={pending || !name.trim() || name.trim() === user.name}>
              Save
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

/** What a session is, from its user agent: this computer's own, the iPhone app, a browser, or another Dorks app. */
export function describeSession(s: Pick<CloudSession, 'userAgent' | 'current'>): string {
  if (s.current) return 'This computer'
  const ua = s.userAgent ?? ''
  if (/CFNetwork|Darwin|Expo|okhttp/i.test(ua) && !/Mozilla/.test(ua)) return 'Dorks on iPhone'
  if (ua.startsWith('Bun/')) return 'Dorks on another computer'
  if (/^(node|undici)/i.test(ua)) return 'A script or API client'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : null
  if (browser) return os ? `${browser} on ${os}` : browser
  return 'Unknown device'
}

const ago = (iso: string) => {
  const t = Date.parse(iso)
  if (!t) return ''
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 1 ? 'Active now' : m < 60 ? `Active ${m} min ago` : m < 48 * 60 ? `Active ${Math.round(m / 60)} h ago` : `Active ${Math.round(m / 1440)} days ago`
}

/** Where the account is signed in: sign one out, or all but this computer (this one's is Sign out above). */
function Sessions() {
  const place = useCloudPlace()!
  const actions = place.home.actions
  const account = useStoreValue(place.home.cloudAccount())
  const sessions = account.data?.sessions ?? []
  const others = sessions.filter((s) => !s.current)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Sessions"
      description="Everywhere your Dorks Cloud account is signed in."
      actions={
        others.length > 1 ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.cloudSignOutOthers())}>
            Sign out all others
          </Button>
        ) : undefined
      }
    >
      <SettingsGroup label="sessions">
        {!account.data && <SettingsRow label={account.error ? 'Could not list your sessions' : 'Loading…'} />}
        {sessions.map((s) => (
          <SettingsRow
            key={s.id}
            label={describeSession(s)}
            description={[s.current ? 'Active now' : ago(s.updatedAt), s.ipAddress].filter(Boolean).join(' · ')}
            control={
              s.current ? (
                <span className="text-xs text-muted-foreground">This session</span>
              ) : (
                <Button size="sm" variant="outline" disabled={pending} aria-label={`Sign out ${describeSession(s)}`} onClick={() => void run(() => actions.cloudSignOutSession(s.id))}>
                  Sign out
                </Button>
              )
            }
          />
        ))}
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}

/** Invitations waiting for you (accept, then work in the org), and the code from an invitation email for one that is not listed. */
function Invitations() {
  const place = useCloudPlace()!
  const navigate = useNavigate()
  const invitations = useCloudInvitations()
  const [code, setCode] = useState('')
  const { run, pending, error } = usePending()
  const answer = (id: string, orgId: string, accept: boolean) =>
    void run(async () => {
      await place.home.actions.cloudOrgAction(accept ? 'accept-invitation' : 'reject-invitation', { invitationId: id })
      if (!accept) return
      place.chooseOrg(orgId)
      void navigate({ to: '/dorks', search: {} })
    })
  return (
    <SettingsSection title="Invitations" description={invitations.length ? undefined : 'Invitations to an organization show up here.'}>
      <SettingsGroup label="invitations">
        {invitations.map((i) => (
          <SettingsRow
            key={i.id}
            label={i.organizationName ?? 'An organization'}
            description={`${i.inviterEmail ? `From ${i.inviterEmail}, as` : 'As'} ${i.role}`}
            control={
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => answer(i.id, i.organizationId, false)}>
                  Decline
                </Button>
                <Button size="sm" disabled={pending} onClick={() => answer(i.id, i.organizationId, true)}>
                  Join
                </Button>
              </>
            }
          />
        ))}
        <SettingsInputRow
          id="invite-code"
          label="Invitation code"
          description="From the invitation email"
          aria-label="invitation code"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          trailing={
            <Button size="sm" variant="outline" disabled={!code.trim()} onClick={() => void navigate({ to: '/invite/$id', params: { id: code.trim() } })}>
              Open
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}
