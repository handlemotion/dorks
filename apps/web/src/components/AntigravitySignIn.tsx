import { useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { useDorksClient } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { openExternal } from '../lib/desktop'
import { usePending } from '../lib/pending'

/**
 * Antigravity's one-button Google sign-in (apps/server/src/services/antigravitySignIn.ts): the server runs agy's own sign-in and
 * hands back Google's page, which opens in the browser. A browser on another computer cannot reach agy's localhost redirect, so
 * the address it ended on can be pasted here instead. Connected, it offers Sign out where `signOut` is set (Settings).
 */
export function AntigravitySignIn({ settings, signOut }: { settings: Settings; signOut?: boolean }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const signIn = settings.antigravitySignIn
  if (settings.antigravityToken) {
    return signOut ? (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.updateSettings({ antigravityToken: '' }))}>
        Sign out
      </Button>
    ) : null
  }
  const start = () =>
    void run(async () => {
      const state = await actions.signInAntigravity()
      if (state?.state === 'signing_in' && state.url) openExternal(state.url)
    })
  if (signIn?.state === 'installing')
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
        Getting the Antigravity CLI…
      </span>
    )
  if (signIn?.state === 'signing_in' && signIn.url) return <Waiting url={signIn.url} />
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button size="sm" variant="outline" disabled={pending} onClick={start}>
        {pending ? 'Opening…' : signIn?.state === 'failed' ? 'Try again' : 'Sign in with Google'}
      </Button>
      {(error ?? signIn?.error) && <span className="text-xs text-destructive">{error ?? signIn?.error}</span>}
    </div>
  )
}

/** Approving in the browser: the link again, and the paste for a browser on another computer. */
function Waiting({ url }: { url: string }) {
  const { actions } = useDorksClient()
  const [address, setAddress] = useState('')
  const [elsewhere, setElsewhere] = useState(false)
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
      {elsewhere && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (address.trim()) void run(() => actions.finishAntigravitySignIn(address.trim()))
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
