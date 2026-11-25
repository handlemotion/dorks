import { useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import type { PhoneStatus } from '@dorks/client'
import { useDorksClient, usePhone } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { usePending } from '../../lib/pending'
import { EmptyState } from '../EmptyState'
import { SettingsFacts, SettingsGroup, SettingsRow, SettingsSection, SettingsSections, SettingsStatus, StatusDot, type Tone } from './kit'

// Phone (docs/mobile.md): pair this Mac with the Dorks iPhone app. The phone reaches this server through the cloud relay, which
// the server dials itself; the code and QR code below let a signed-in phone claim this Mac.

const LINK: Record<PhoneStatus['link'], { tone: Tone; label: string }> = {
  online: { tone: 'success', label: 'Online' },
  connecting: { tone: 'running', label: 'Connecting' },
  offline: { tone: 'warning', label: 'Offline, retrying' },
  off: { tone: 'idle', label: 'Off' },
}

export function PhonePage() {
  const phone = usePhone()
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  if (!phone) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>
  if (!phone.cloudUrl) return <EmptyState figure="relay" title="Phone relay is off" description="Set DORKS_CLOUD_URL to pair the Dorks iPhone app." />
  return (
    <SettingsSections>
      {phone.paired ? (
        <SettingsSection title="Paired" description="Your phone reaches this Mac while Dorks is running here.">
          <SettingsGroup>
            <SettingsRow
              label={phone.name || 'This Mac'}
              description={
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={LINK[phone.link].tone} />
                  {LINK[phone.link].label}
                </span>
              }
              control={
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.unpairPhone())}>
                  Unpair
                </Button>
              }
            />
          </SettingsGroup>
          <SettingsStatus error={error} />
        </SettingsSection>
      ) : (
        <SettingsSection title="Pair your phone" description="Open Dorks on your iPhone, sign in, and scan this code.">
          {phone.pairing ? (
            <PairingCode pairing={phone.pairing} onCancel={() => void run(() => actions.cancelPhonePair())} />
          ) : (
            <EmptyState figure="laptop" title="No phone paired" description="A code appears here for your phone to scan.">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.pairPhone())}>
                Pair a phone
              </Button>
            </EmptyState>
          )}
          <SettingsStatus error={error} />
        </SettingsSection>
      )}
    </SettingsSections>
  )
}

function PairingCode({ pairing, onCancel }: { pairing: NonNullable<PhoneStatus['pairing']>; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((pairing.expiresAt - now) / 1000))
  const svg = renderSVG(pairing.url, { border: 1, whiteColor: '#ffffff', blackColor: '#000000' })
  return (
    <SettingsGroup>
      <div className="flex flex-col items-center gap-4 px-4 py-6">
        {/* The QR code stays black on white in both themes, so every camera reads it. */}
        <div className="size-44 overflow-hidden rounded-[6px] [&>svg]:size-full" data-testid="phone-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <SettingsFacts
          items={[
            { label: 'Code', value: <span className="font-mono">{pairing.code}</span>, testId: 'phone-code' },
            { label: 'Expires in', value: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` },
          ]}
        />
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </SettingsGroup>
  )
}
