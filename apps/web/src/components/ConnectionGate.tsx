import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { DorksProvider, useAutomations, useConnection, useDorks, useSettingsState } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Input } from '@dorks/ui/input'
import { clearConnection, currentConnection, DEFAULT_SERVER, normalizeServerUrl, saveConnection, type Connection } from '../lib/connection'
import { onRuntimeConfig, setKeepAwake } from '../lib/desktop'
import type { CloudServer } from '@dorks/client'
import { CloudPlaceProvider, orgName, useCloudPlace, type CloudPlace } from './CloudPlace'
import { EmptyState } from './EmptyState'

const DISCONNECT = createContext<(() => void) | null>(null)

/** Lets the user switch server/token. `null` when the desktop shell manages the connection. */
export const useDisconnect = () => useContext(DISCONNECT)

/**
 * Owner-token gate around the app: finds the server (desktop-injected, or typed once), proves the token works by loading
 * settings, and only then renders the app. A wrong token or an unreachable server gets its own screen, never a half-empty UI.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<Connection | null>(currentConnection)
  // The shell republishes its config when it changes (after a restart); pick up a changed port or token.
  useEffect(() => onRuntimeConfig(() => setConn(currentConnection())), [])
  const bootError = window.__DORKS__?.bootError
  if (bootError) {
    return (
      <GateScreen>
        <GateCard>
          <GateTitle>Dorks could not start</GateTitle>
          <p role="alert">{bootError}</p>
          <p>Quit and reopen the app. If it keeps happening, open the server log from the menu bar icon.</p>
        </GateCard>
      </GateScreen>
    )
  }
  if (!conn) return <ConnectForm onConnect={(c) => setConn(c)} />
  const disconnect =
    conn.source === 'stored'
      ? () => {
          clearConnection()
          setConn(null)
        }
      : null
  return (
    <DISCONNECT.Provider value={disconnect}>
      <Connected
        key={`${conn.serverUrl}|${conn.token}`}
        conn={conn}
        onChange={() => {
          clearConnection()
          setConn(null)
        }}
        onReplace={setConn}
      >
        {children}
      </Connected>
    </DISCONNECT.Provider>
  )
}

/**
 * The home server's client, and the client of the server the picked Dorks Cloud org lands on (CloudPlace.tsx): the same one on this
 * Mac, another server through this one otherwise. Switching servers remounts the app on the new client.
 */
function Connected({ conn, onChange, onReplace, children }: { conn: Connection; onChange: () => void; onReplace: (c: Connection) => void; children: ReactNode }) {
  return (
    <CloudPlaceProvider conn={conn}>
      {(client, place) => {
        if (place.resolving) return <Connecting />
        if (place.target.kind === 'choose') return <ChooseMachine place={place} machines={place.target.machines} />
        const remote = place.target.kind === 'remote' ? place.target.server : null
        return (
          <DorksProvider key={remote?.id ?? 'home'} client={client}>
            <Probe conn={conn} remote={remote} onChange={onChange} onReplace={onReplace}>
              {children}
            </Probe>
          </DorksProvider>
        )
      }}
    </CloudPlaceProvider>
  )
}

function Connecting() {
  return (
    <GateScreen>
      <p role="status" className="text-sm text-muted-foreground">
        Connecting…
      </p>
    </GateScreen>
  )
}

/** Where the org cannot pick a server alone: several Macs (or none online), or none at all yet. A way back is always there. */
function ChooseMachine({ place, machines }: { place: CloudPlace; machines: CloudServer[] }) {
  const name = orgName(place.org, place.cloud)
  // At most two buttons: the online Macs first.
  const shown = machines.toSorted((a, b) => Number(b.online) - Number(a.online)).slice(0, 2)
  return (
    <GateScreen>
      <div className="flex flex-col items-center gap-2">
        {machines.length === 0 ? (
          <EmptyState figure="laptop" title={`Nothing runs ${name} yet`} description="Pair a Mac with this organization, or add a hosted server, and it shows up here." />
        ) : (
          <EmptyState figure="laptop" title={`Connect to a Mac in ${name}`} description={machines.some((m) => m.online) ? undefined : 'None of its Macs is online. Open Dorks on one of them.'}>
            {shown.map((m) => (
              <Button key={m.id} size="sm" variant="outline" disabled={!m.online} onClick={() => place.chooseMachine(m.id)}>
                Connect to {m.name}
              </Button>
            ))}
          </EmptyState>
        )}
        <Button size="sm" variant="ghost" onClick={() => place.chooseOrg(null)}>
          Back to {orgName(place.personal, place.cloud)}
        </Button>
      </div>
    </GateScreen>
  )
}

/** Another server could not be reached (offline, or the cloud refused): say so, and offer the way back to this Mac. */
function RemoteGate({ server, rejected }: { server: CloudServer; rejected: boolean }) {
  const place = useCloudPlace()
  const inPersonal = !place?.org || place.org.personal
  return (
    <GateScreen>
      <GateCard>
        <GateTitle>Can’t reach {server.name}</GateTitle>
        <p role="alert">
          {rejected
            ? `Dorks Cloud did not let you in to ${server.name}. Ask an admin of the organization, or sign in again in Settings.`
            : `${server.name} is not answering. It comes back once Dorks runs there again; this page keeps retrying.`}
        </p>
        <Button variant="outline" onClick={() => (inPersonal ? place?.chooseMachine(undefined) : place?.chooseOrg(null))}>
          {inPersonal ? 'Back to this Mac' : `Back to ${orgName(place?.personal ?? null, place?.cloud)}`}
        </Button>
      </GateCard>
    </GateScreen>
  )
}

function Probe({ conn, remote, onChange, onReplace, children }: { conn: Connection; remote: CloudServer | null; onChange: () => void; onReplace: (c: Connection) => void; children: ReactNode }) {
  const settings = useSettingsState()
  const connection = useConnection()
  const rejected = connection.unauthorized || settings.error?.code === 'forbidden'
  if (remote && (rejected || (settings.status === 'error' && !settings.data))) return <RemoteGate server={remote} rejected={rejected} />
  if (rejected) {
    return conn.source === 'stored' ? (
      <ConnectForm initialUrl={conn.serverUrl} error="The server rejected that owner token." onConnect={onReplace} />
    ) : (
      <GateScreen>
        <GateCard>
          <GateTitle>Token rejected</GateTitle>
          <p role="alert">The dorks server did not accept the app's owner token. Quit and reopen Dorks.</p>
        </GateCard>
      </GateScreen>
    )
  }
  if (settings.status === 'loading') return <Connecting />
  if (settings.status === 'error' && !settings.data) {
    return (
      <GateScreen>
        <GateCard>
          <GateTitle>Can’t reach the dorks server</GateTitle>
          <p role="alert">
            Nothing answered at <code>{conn.serverUrl}</code>.{' '}
            {conn.source === 'desktop' ? 'The app is still starting it. This page keeps retrying.' : 'Start the server, or connect to a different one. This page keeps retrying.'}
          </p>
          {conn.source === 'stored' && (
            <Button variant="outline" onClick={onChange}>
              Change server
            </Button>
          )}
        </GateCard>
      </GateScreen>
    )
  }
  return (
    <>
      {/* Only this Mac's own work holds it awake; another server's runs there. */}
      {!remote && <KeepAwake />}
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
    <GateScreen>
      <GateCard as="form" onSubmit={submit}>
        <GateTitle>Connect to your dorks server</GateTitle>
        <p className="text-muted-foreground">The desktop app does this for you. In a browser, enter the address of your local server and its owner token.</p>
        <label className="flex flex-col gap-1.5 font-medium">
          Server <Input aria-label="server" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1.5 font-medium">
          Owner token <Input aria-label="owner token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
        {(error || formError) && (
          <p role="alert" className="text-destructive">
            {formError || error}
          </p>
        )}
        <Button type="submit" size="lg">
          Connect
        </Button>
      </GateCard>
    </GateScreen>
  )
}

/**
 * Holds the Mac awake (desktop app only) while any session is starting or working, so idle sleep does not stall the agent, and while
 * an active automation has a schedule: the server runs on this Mac, so a scheduled run can only start on time if the Mac is awake and
 * the app is open (the shell also opens the app at login while a schedule exists).
 */
function KeepAwake() {
  const dorks = useDorks(false)
  const automations = useAutomations()
  const working = !!dorks?.some((d) => d.state === 'creating' || d.state === 'working' || d.state === 'waking')
  const scheduled = automations ? automations.some((a) => a.nextRunAt !== null) : undefined
  const active = working || !!scheduled
  useEffect(() => {
    // `scheduled` also makes the app open at login: the server runs only while the app does.
    setKeepAwake(active, scheduled)
  }, [active, scheduled])
  return null
}

/** Full-window states before the app is usable (connect, rejected token, server unreachable), on the theme's glass backdrop. */
function GateScreen({ children }: { children: ReactNode }) {
  return <main className="app-backdrop flex min-h-svh items-center justify-center p-6 text-foreground">{children}</main>
}

function GateCard({ as = 'section', className = '', children, ...props }: { as?: 'section' | 'form'; className?: string; children: ReactNode } & React.ComponentProps<'form'>) {
  const Tag = as as 'form'
  return (
    <Tag className={`glass-strong flex w-full max-w-md flex-col gap-4 rounded-3xl p-8 text-sm ${className}`} {...props}>
      {children}
    </Tag>
  )
}

function GateTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-lg font-medium tracking-tight">{children}</h1>
}
