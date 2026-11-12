import { Link } from '@tanstack/react-router'
import { useDorksClient, useSnapshot } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { Progress } from '@dorks/ui/progress'
import { isDesktop } from '../lib/desktop'
import { usePending } from '../lib/pending'

/**
 * What still stands between the owner and a first session, shown where sessions are created instead of as onboarding steps:
 * the base snapshot (built in the background once the Boat key is saved) and the public URL sandboxes use to reach this Mac.
 * Renders nothing once both are in place.
 */
export function SetupStatus({ settings }: { settings: Settings }) {
  return (
    <div className="flex flex-col gap-3 empty:hidden">
      <SnapshotStatus settings={settings} />
      {settings.boxProvider !== 'sim' && !settings.publicUrlConfigured && <TunnelPrompt />}
    </div>
  )
}

function SnapshotStatus({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const snap = useSnapshot()
  const { run, pending, error } = usePending()
  if (!snap || (settings.baseSnapshotId && snap.state !== 'failed' && snap.state !== 'building')) return null
  const build = () => void run(async () => void (await actions.buildSnapshot()))

  if (snap.state === 'building') {
    return (
      <div role="status" aria-label="snapshot build progress" data-testid="snapshot-progress" className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          Preparing Boat, step {snap.stepIndex + 1} of {snap.stepCount}: {snap.message}
        </p>
        <Progress value={((snap.stepIndex + 1) / snap.stepCount) * 100} aria-label="build progress" />
      </div>
    )
  }
  if (snap.state === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p role="alert" data-testid="snapshot-error" className="text-destructive">
          Preparing Boat failed: {snap.error}
          {/[.!?]$/.test(snap.error ?? '') ? '' : '.'}
          {settings.baseSnapshotId ? ` Sessions keep using ${settings.baseSnapshotId}.` : ''}
        </p>
        <Button size="sm" variant="outline" disabled={pending || !snap.canBuild} onClick={build}>
          {pending ? 'Starting…' : 'Retry'}
        </Button>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }
  // No snapshot and nothing running: a key saved before builds started by themselves, or the build could not start.
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p role="status" className="text-muted-foreground">
        {snap.cannotBuildReason ?? 'Boat needs preparing before the first session (a few minutes).'}
      </p>
      <Button size="sm" variant="outline" disabled={pending || !snap.canBuild} onClick={build}>
        {pending ? 'Starting…' : 'Prepare Boat'}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Sandboxes reach this Mac through a public address: the desktop app's own private tunnel, or an address in Settings. */
function TunnelPrompt() {
  const tunnel = window.__DORKS__?.tunnel
  return (
    <p role="status" data-testid="tunnel-missing" className="text-sm text-muted-foreground">
      Sandboxes cannot reach this Mac yet{tunnel?.error ? ` (${tunnel.error})` : ''}, so sessions will not start.{' '}
      {isDesktop() ? (
        <>
          Set a public URL in{' '}
          <Link to="/settings" className="font-medium underline underline-offset-4">
            Settings
          </Link>
          .
        </>
      ) : (
        <>
          Start the server with <code>DORKS_PUBLIC_URL</code> set to your tunnel’s address.
        </>
      )}
    </p>
  )
}
