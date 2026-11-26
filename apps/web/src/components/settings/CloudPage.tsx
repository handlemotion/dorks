import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@dorks/ui/button'
import { usePending } from '../../lib/pending'
import { orgName, useCloudPlace } from '../CloudPlace'
import { EmptyState } from '../EmptyState'
import { OrgMark } from '../OrgSwitcher'
import { SettingsGroup, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsStatus, StatusDot } from './kit'

// Dorks Cloud (docs/mobile.md, "Desktop: Dorks Cloud"): sign this app in with the account the phone uses, by an emailed code. The
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
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const { run, pending, error } = usePending()
  const actions = place.home.actions
  return (
    <SettingsSections>
      <SettingsSection title="Sign in to Dorks Cloud" description="Work in your organizations and on your other Macs from here. Use the account you use on your phone.">
        {sentTo ? (
          <SettingsGroup label="Code" onSubmit={() => void run(() => actions.cloudVerify(sentTo, code))}>
            <SettingsInputRow
              id="cloud-code"
              label="Code"
              description={`Sent to ${sentTo}`}
              aria-label="sign-in code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              trailing={
                <Button type="submit" size="sm" disabled={pending || code.replace(/\s+/g, '').length < 6}>
                  Sign in
                </Button>
              }
            />
            <SettingsRow
              label="No code?"
              description="It can take a minute. Check your spam folder."
              control={
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => (setSentTo(null), setCode(''))}>
                  Use another email
                </Button>
              }
            />
          </SettingsGroup>
        ) : (
          <SettingsGroup label="Email" onSubmit={() => void run(async () => (await actions.cloudSendCode(email.trim()), setSentTo(email.trim())))}>
            <SettingsInputRow
              id="cloud-email"
              label="Email"
              description="We email you a six-digit code."
              aria-label="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              trailing={
                <Button type="submit" size="sm" disabled={pending || !email.includes('@')}>
                  Send code
                </Button>
              }
            />
          </SettingsGroup>
        )}
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
