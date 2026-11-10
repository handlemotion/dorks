import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { createClient } from '@dorks/client'
import { DorksProvider, useConnection, useDorks, useSettingsState } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { clearConnection, currentConnection, DEFAULT_SERVER, normalizeServerUrl, saveConnection, type Connection } from '../lib/connection'
import { onRuntimeConfig, setKeepAwake } from '../lib/desktop'

const DISCONNECT = createContext<(() => void) | null>(null)

/** Lets the user switch server/token. `null` when the desktop shell manages the connection. */
export const useDisconnect = () => useContext(DISCONNECT)

/**
 * Owner-token gate around the app: finds the server (desktop-injected, or typed once), proves the token works by loading
 * settings, and only then renders the app. A wrong token or an unreachable server gets its own screen, never a half-empty UI.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<Connection | null>(currentConnection)
  // The shell republishes its config when it changes (a new public URL restarts the server); pick up a changed port or token.
  useEffect(() => onRuntimeConfig(() => setConn(currentConnection())), [])
  const bootError = window.__DORKS__?.bootError
  if (bootError) {
    return (
      <main className="gate">
        <section className="gate-card">
          <h1>Dorks could not start</h1>
          <p role="alert">{bootError}</p>
          <p>Quit and reopen the app. If it keeps happening, open the server log from the menu bar icon.</p>
        </section>
      </main>
    )
  }
  if (!conn) return <ConnectForm onConnect={(c) => setConn(c)} />
  const disconnect = conn.source === 'stored' ? () => { clearConnection(); setConn(null) } : null
  return (
    <DISCONNECT.Provider value={disconnect}>
      <Connected key={`${conn.serverUrl}|${conn.token}`} conn={conn} onChange={() => { clearConnection(); setConn(null) }} onReplace={setConn}>{children}</Connected>
    </DISCONNECT.Provider>
  )
}

function Connected({ conn, onChange, onReplace, children }: { conn: Connection; onChange: () => void; onReplace: (c: Connection) => void; children: ReactNode }) {
  const client = useMemo(() => createClient({ baseUrl: conn.serverUrl, token: conn.token }), [conn.serverUrl, conn.token])
  return (
    <DorksProvider client={client}>
      <Probe conn={conn} onChange={onChange} onReplace={onReplace}>{children}</Probe>
    </DorksProvider>
  )
}

function Probe({ conn, onChange, onReplace, children }: { conn: Connection; onChange: () => void; onReplace: (c: Connection) => void; children: ReactNode }) {
  const settings = useSettingsState()
  const connection = useConnection()
  const rejected = connection.unauthorized || settings.error?.code === 'forbidden'
  if (rejected) {
    return conn.source === 'stored' ? (
      <ConnectForm initialUrl={conn.serverUrl} error="The server rejected that owner token." onConnect={onReplace} />
    ) : (
      <main className="gate"><section className="gate-card"><h1>Token rejected</h1><p role="alert">The dorks server did not accept the app's owner token. Quit and reopen Dorks.</p></section></main>
    )
  }
  if (settings.status === 'loading') return <main className="gate"><p role="status">Connecting…</p></main>
  if (settings.status === 'error' && !settings.data) {
    return (
      <main className="gate">
        <section className="gate-card">
          <h1>Can’t reach the dorks server</h1>
          <p role="alert">Nothing answered at <code>{conn.serverUrl}</code>. {conn.source === 'desktop' ? 'The app is still starting it. This page keeps retrying.' : 'Start the server, or connect to a different one. This page keeps retrying.'}</p>
          {conn.source === 'stored' && <Button variant="outline" onClick={onChange}>Change server</Button>}
        </section>
      </main>
    )
  }
  return (
    <>
      {connection.live === 'offline' && <p className="connection-banner" role="status">Reconnecting to the dorks server…</p>}
      <KeepAwake />
      {children}
    </>
  )
}

function ConnectForm({ initialUrl, error, onConnect }: { initialUrl?: string; error?: string; onConnect: (c: Connection) => void }) {
  const [url, setUrl] = useState(initialUrl ?? (import.meta.env.VITE_DORKS_SERVER as string | undefined) ?? DEFAULT_SERVER)
  const [token, setToken] = useState('')
  const [formError, setFormError] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const serverUrl = normalizeServerUrl(url)
    if (!serverUrl) return setFormError('Enter a server address like http://127.0.0.1:4747')
    if (!token.trim()) return setFormError('Enter the owner token.')
    saveConnection(serverUrl, token.trim())
    onConnect({ serverUrl, token: token.trim(), source: 'stored' })
  }
  return (
    <main className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Connect to your dorks server</h1>
        <p>The desktop app does this for you. In a browser, enter the address of your local server and its owner token.</p>
        <label>Server <input aria-label="server" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label>Owner token <input aria-label="owner token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
        {(error || formError) && <p role="alert">{formError || error}</p>}
        <Button type="submit">Connect</Button>
      </form>
    </main>
  )
}

/** Holds the Mac awake (desktop app only) while any session is starting or working, so a closed lid does not stall the agent. */
function KeepAwake() {
  const dorks = useDorks(false)
  const active = !!dorks?.some((d) => d.state === 'creating' || d.state === 'working' || d.state === 'waking')
  useEffect(() => {
    setKeepAwake(active)
  }, [active])
  return null
}
