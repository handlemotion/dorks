import { useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { useDorksClient } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { openExternal } from '../lib/desktop'
import { usePending } from '../lib/pending'

/** A sign-in the server runs with an agent's own CLI on its computer: its state and the link to approve. */
type SignInState = { state: 'signed_out' | 'installing' | 'signing_in' | 'failed'; url?: string; error?: string; remote?: boolean }

/**
 * One-button sign-in run by an agent's CLI on the server's computer (Antigravity's Google sign-in, Codex's ChatGPT one): the server
 * hands back the provider's page, which opens in the browser. A browser on another computer cannot reach the CLI's localhost
 * redirect, so the address it ended on can be pasted here instead; a sign-in run in a sandbox for a cloud org (`remote`, dorks-cloud
 * src/runtime/antigravity.ts) opens that paste at once. Signed in, it offers Sign out where `onSignOut` is set.
 */
export function CliSignIn({
  signedIn,
  view,
  label,
  installing = 'Getting the CLI…',
  remoteStarting = 'Starting the sign-in…',
  start,
  finish,
  onSignOut,
}: {
  signedIn: boolean
  view?: SignInState | null
  label: string
  installing?: string
  /** What shows while a cloud org's sandbox starts the sign-in. */
  remoteStarting?: string
  start: () => Promise<SignInState | null | undefined>
  finish: (url: string) => Promise<unknown>
  onSignOut?: () => Promise<unknown>
}) {
  const { run, pending, error } = usePending()
  if (signedIn) {
    return onSignOut ? (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(onSignOut)}>
        Sign out
      </Button>
    ) : null
  }
  const go = () =>
    void run(async () => {
      const state = await start()
      if (state?.state === 'signing_in' && state.url) openExternal(state.url)
    })
  if (starting(view, pending)) return <Starting text={view?.remote ? remoteStarting : installing} />
  if (view?.state === 'signing_in' && view.url) return <Waiting url={view.url} finish={finish} remote={!!view.remote} />
  return <SignInButton label={pending ? 'Opening…' : view?.state === 'failed' ? 'Try again' : label} disabled={pending} onClick={go} error={error ?? view?.error} />
}

/** The CLI is being fetched (on this computer), or a cloud org's sandbox is starting its sign-in. */
const starting = (view: SignInState | null | undefined, pending: boolean) => view?.state === 'installing' || (pending && !!view?.remote)

function Starting({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
      {text}
    </span>
  )
}

function SignInButton({ label, disabled, onClick, error }: { label: string; disabled: boolean; onClick: () => void; error?: string }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button size="sm" variant="outline" disabled={disabled} onClick={onClick}>
        {label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

/** Antigravity's Google sign-in (apps/server/src/services/antigravitySignIn.ts). */
export function AntigravitySignIn({ settings, signOut }: { settings: Settings; signOut?: boolean }) {
  const { actions } = useDorksClient()
  return (
    <CliSignIn
      signedIn={!!settings.antigravityToken}
      view={settings.antigravitySignIn}
      label="Sign in with Google"
      installing="Getting the Antigravity CLI…"
      remoteStarting="Starting the Google sign-in…"
      start={actions.signInAntigravity}
      finish={actions.finishAntigravitySignIn}
      onSignOut={signOut ? () => actions.updateSettings({ antigravityToken: '' }) : undefined}
    />
  )
}

/** Codex's ChatGPT sign-in, kept by the Codex CLI on the server's computer (apps/server/src/services/codexSignIn.ts). */
export function CodexSignIn({ settings, signOut }: { settings: Settings; signOut?: boolean }) {
  const { actions } = useDorksClient()
  return (
    <CliSignIn
      signedIn={!!settings.codexAccount}
      view={settings.codexSignIn}
      label="Sign in with ChatGPT"
      start={actions.signInCodex}
      finish={actions.finishCodexSignIn}
      onSignOut={signOut ? actions.signOutCodex : undefined}
    />
  )
}

/** Approving in the browser: the link again, and the paste for a browser on another computer. */
function Waiting({ url, finish, remote }: { url: string; finish: (url: string) => Promise<unknown>; remote: boolean }) {
  const [address, setAddress] = useState('')
  const [elsewhere, setElsewhere] = useState(remote)
  const { run, pending, error } = usePending()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
          Approve in your browser
        </span>
        <Button size="sm" variant="outline" onClick={() => openExternal(url)}>
          Open sign-in
        </Button>
        {!elsewhere && (
          <Button size="sm" variant="ghost" onClick={() => setElsewhere(true)}>
            Other computer
          </Button>
        )}
      </div>
      {remote && <span className="text-xs text-muted-foreground">After you approve, the browser shows a page that can’t load. Paste its address here.</span>}
      {elsewhere && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (address.trim()) void run(() => finish(address.trim()))
          }}
        >
          <Input
            aria-label="Address the sign-in ended on"
            className="h-8"
            autoComplete="off"
            placeholder="http://localhost:…/auth/callback?code=…"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Button size="sm" variant="outline" type="submit" disabled={pending || !address.trim()}>
            {pending ? 'Finishing…' : 'Finish'}
          </Button>
        </form>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
