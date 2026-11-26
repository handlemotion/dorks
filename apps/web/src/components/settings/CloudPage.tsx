import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@dorks/ui/button'
import { startCloudSignIn } from '../../lib/cloudSignIn'
import { usePending } from '../../lib/pending'
import { orgName, useCloudInvitations, useCloudPlace } from '../CloudPlace'
import { EmptyState } from '../EmptyState'
import { OrgMark } from '../OrgSwitcher'
import { SettingsGroup, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsStatus, StatusDot } from './kit'

// Dorks Cloud (docs/mobile.md, "Desktop: Dorks Cloud"): sign this app in with the account the phone uses, in the browser. The
// session is kept by this Mac's server (encrypted), which then lists the account's organizations for the sidebar's switcher and
// reaches their servers through the relay.

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
      <SettingsSection title="Account">
        <SettingsGroup>
          <SettingsRow
            label={user.name}
            description={user.email}
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
