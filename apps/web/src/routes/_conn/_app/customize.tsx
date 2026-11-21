import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CheckIcon, PlusIcon, XIcon } from 'lucide-react'
import type { McpServerInput, McpServerView } from '@dorks/client'
import { useComposio, useDorksClient, useMcpServers } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Textarea } from '@dorks/ui/textarea'
import { COMPOSIO, CONNECTORS, connectorById, KINDS, type ComposioApp, type Connector, type KeyConnector } from '../../../components/connectors'
import { PageHeader } from '../../../components/PageHeader'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSections } from '../../../components/settings/kit'
import { usePending } from '../../../lib/pending'

// Customize (docs/mcp.md): the connector catalog and the owner's custom MCP servers. Every agent gets them, in every sandbox, next to the built-in `dorks` server.
// Header and variable values are write-only: the list shows their names, and an edit keeps a saved value unless a new one is typed.

export const Route = createFileRoute('/_conn/_app/customize')({ component: Customize })

/** What the custom connector dialog starts from: a blank one or a saved one. */
type Draft = { editing: boolean; name: string; transport: 'http' | 'stdio'; url: string; command: string; args: string; headers: Pair[]; env: Pair[] }
/** A header or variable. `saved` means the server holds a value: an empty field keeps it. */
type Pair = { key: string; value: string; saved: boolean }

const BLANK: Draft = { editing: false, name: '', transport: 'http', url: '', command: '', args: '', headers: [], env: [] }

const draftOf = (s: McpServerView): Draft => ({
  editing: true,
  name: s.name,
  transport: s.transport,
  url: s.url ?? '',
  command: s.command ?? '',
  args: s.args.join('\n'),
  headers: s.headerNames.map((key) => ({ key, value: '', saved: true })),
  env: s.envNames.map((key) => ({ key, value: '', saved: true })),
})

function Customize() {
  const servers = useMcpServers()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [connecting, setConnecting] = useState<Connector | null>(null)
  const composio = useComposio()
  const custom = servers?.filter((s) => !isPreset(s) && !isComposio(s)) ?? []
  const isConnected = (c: Connector) => (c.toolkit ? !!composio?.toolkits.includes(c.toolkit) : !!servers?.some((s) => s.name === c.id && isPreset(s)))
  /** A card opens its dialog, or the editor when a custom server already holds its name (the card would replace it). */
  const open = (c: Connector) => {
    const taken = !c.toolkit && servers?.find((s) => s.name === c.id && !isPreset(s))
    if (taken) setDraft(draftOf(taken))
    else setConnecting(c)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Customize"
        actions={
          <Button size="sm" onClick={() => setDraft(BLANK)}>
            <PlusIcon data-icon="inline-start" />
            Add connector
          </Button>
        }
      />
      <div className="app-main min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-16 sm:px-6">
          <SettingsSections>
            {KINDS.map((k) => (
              <SettingsSection key={k.id} title={k.title}>
                <ul aria-label={k.title} className="grid gap-2 md:grid-cols-2">
                  {CONNECTORS.filter((c) => c.kind === k.id).map((c) => (
                    <ConnectorCard key={c.id} connector={c} connected={isConnected(c)} loading={!servers || (!!c.toolkit && !composio)} onOpen={() => open(c)} />
                  ))}
                </ul>
              </SettingsSection>
            ))}
            {custom.length > 0 && (
              <SettingsSection title="Custom connectors">
                <SettingsGroup label="custom connectors">
                  {custom.map((s) => (
                    <ServerRow key={s.name} server={s} onEdit={() => setDraft(draftOf(s))} />
                  ))}
                </SettingsGroup>
              </SettingsSection>
            )}
          </SettingsSections>
        </div>
      </div>
      {draft && <ServerDialog key={`${draft.name}:${draft.editing}`} initial={draft} onClose={() => setDraft(null)} />}
      {connecting &&
        (connecting.toolkit !== undefined ? (
          <AppDialog
            key={connecting.id}
            app={connecting}
            keySaved={!!composio?.connected}
            instant={composio?.personal ? composio.instant : undefined}
            statusError={composio?.error}
            connected={isConnected(connecting)}
            onClose={() => setConnecting(null)}
          />
        ) : (
          <ConnectDialog key={connecting.id} connector={connecting} connected={isConnected(connecting)} onClose={() => setConnecting(null)} />
        ))}
    </div>
  )
}

/** The server a Composio key saves (services/composio.ts), not a custom server that only shares the name. */
const isComposio = (s: McpServerView) => s.name === COMPOSIO.id && s.transport === 'http' && (s.headerNames.includes('x-api-key') || s.headerNames.includes('x-user-api-key'))

/** Whether a saved server is a key connector's own preset, not a custom server that only shares its name. */
function isPreset(s: McpServerView) {
  const c = connectorById(s.name)
  if (!c) return false
  const p = c.server('')
  if (p.transport !== s.transport) return false
  return p.transport === 'http' ? p.url === s.url : p.command === s.command && JSON.stringify(p.args) === JSON.stringify(s.args)
}

/** The brand mark: the path in its colour (the foreground when the colour is too dark to read), or a monogram. */
function ConnectorIcon({ connector: c }: { connector: Connector }) {
  if (!c.icon)
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-xs text-foreground">
        {c.name[0]}
      </span>
    )
  const dark = luminance(c.icon.hex) < 0.12
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5 shrink-0" fill={dark ? 'currentColor' : `#${c.icon.hex}`} fillRule={c.icon.evenodd ? 'evenodd' : undefined}>
      <path d={c.icon.path} />
    </svg>
  )
}

function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** One catalog entry: the whole card opens its dialog. */
function ConnectorCard({ connector: c, connected, loading, onOpen }: { connector: Connector; connected: boolean; loading: boolean; onOpen: () => void }) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-label={connected ? `manage ${c.name}` : `connect ${c.name}`}
        disabled={loading}
        onClick={onOpen}
        className="group flex w-full min-w-0 items-center gap-3.5 rounded-[8px] border border-foreground/[0.06] bg-surface dark:border-transparent px-4 py-2.5 text-start outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <ConnectorIcon connector={c} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm text-foreground">{c.name}</span>
          <span className="truncate text-xs text-muted-foreground">{c.description}</span>
        </span>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            Connected
          </span>
        ) : (
          <PlusIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
      </button>
    </li>
  )
}

/** Connect a catalog server with its one key, or, once connected, replace the key or remove it. */
function ConnectDialog({ connector: c, connected, onClose }: { connector: KeyConnector; connected: boolean; onClose: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [key, setKey] = useState('')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await actions.putMcpServer(c.id, c.server(key.trim()))
              onClose()
            })
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{connected ? c.name : `Connect ${c.name}`}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {c.description}. Agents see its tools as mcp__{c.id}__*.
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body">
            <Field>
              <FieldLabel htmlFor="connector-key">{c.keyLabel}</FieldLabel>
              <Input id="connector-key" type="password" autoComplete="off" placeholder={connected ? 'Saved' : ''} value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
              <FieldDescription>
                <a href={c.keyUrl} target="_blank" rel="noreferrer">
                  Get your {c.keyLabel.toLowerCase()}
                </a>
                . Stored encrypted and never shown again.
              </FieldDescription>
            </Field>
            {error && (
              <p role="alert" className="mt-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {connected && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="sm:me-auto"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await actions.deleteMcpServer(c.id)
                    onClose()
                  })
                }
              >
                Disconnect
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !key.trim()}>
              {pending ? 'Saving…' : connected ? 'Replace key' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * An app that signs in through Composio. Without a Composio key the dialog asks for it first; then the sign-in opens in a browser
 * and the dialog waits, reading Composio every few seconds, until the app shows up as connected.
 */
function AppDialog({
  app: c,
  keySaved,
  instant,
  statusError,
  connected,
  onClose,
}: {
  app: ComposioApp
  keySaved: boolean
  instant?: boolean
  statusError?: string
  connected: boolean
  onClose: () => void
}) {
  const client = useDorksClient()
  const { actions } = client
  const { run, pending, error } = usePending()
  const [key, setKey] = useState('')
  const [editingKey, setEditingKey] = useState(!keySaved)
  const [link, setLink] = useState<string | null>(null)
  const waiting = !!link && !connected

  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => client.refreshComposio(), 3000)
    return () => clearInterval(t)
  }, [waiting, client])
  useEffect(() => {
    if (link && connected) onClose()
  }, [link, connected, onClose])

  const signIn = () =>
    void run(async () => {
      const { url } = await actions.composioLink(c.toolkit)
      setLink(url)
      window.open(url, '_blank', 'noopener,noreferrer')
    })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (editingKey)
              void run(async () => {
                await actions.connectComposio(key.trim())
                setKey('')
                setEditingKey(false)
              })
            else if (!connected) signIn()
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{connected ? c.name : `Connect ${c.name}`}</DialogTitle>
            <DialogDescription className="text-sm leading-5">{(!editingKey && statusError) || appHint(c, editingKey, connected, waiting)}</DialogDescription>
          </DialogHeader>
          {(editingKey || error) && (
            <div data-slot="dialog-body">
              {editingKey && (
                <Field>
                  <FieldLabel htmlFor="composio-key">Composio {COMPOSIO.keyLabel}</FieldLabel>
                  <Input id="composio-key" type="password" autoComplete="off" placeholder={keySaved ? 'Saved' : ''} value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
                  <FieldDescription>
                    <a href={COMPOSIO.keyUrl} target="_blank" rel="noreferrer">
                      Get your Composio API key
                    </a>
                    . A project key or your personal key (<code>uak_</code>, from <code>composio login</code>) works. Stored encrypted and never shown again.
                    {instant !== undefined &&
                      (instant ? ' Instant is on: agents can search the web on your Composio credits.' : ' Turn on Instant in Composio to let agents search the web on your credits.')}
                  </FieldDescription>
                </Field>
              )}
              {error && (
                <p role="alert" className={editingKey ? 'mt-4 text-xs text-destructive' : 'text-xs text-destructive'}>
                  {error}
                </p>
              )}
            </div>
          )}
          <AppFooter
            app={c}
            keySaved={keySaved}
            editingKey={editingKey}
            connected={connected}
            link={waiting ? link : null}
            pending={pending}
            canSaveKey={!!key.trim()}
            run={run}
            onEditKey={() => setEditingKey(true)}
            onClose={onClose}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function appHint(c: ComposioApp, editingKey: boolean, connected: boolean, waiting: boolean) {
  if (editingKey) return `${c.name} signs in through Composio. Add your Composio API key once, then each app is one sign-in.`
  if (connected) return `${c.description}. Agents reach it through the composio server.`
  if (waiting) return 'Finish signing in on the page that opened. This closes when it is done.'
  return `${c.description}. You sign in once in your browser.`
}

type AppFooterProps = {
  app: ComposioApp
  keySaved: boolean
  editingKey: boolean
  connected: boolean
  link: string | null
  pending: boolean
  canSaveKey: boolean
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  onEditKey: () => void
  onClose: () => void
}

function AppFooter({ app: c, keySaved, editingKey, connected, link, pending, canSaveKey, run, onEditKey, onClose }: AppFooterProps) {
  const { actions } = useDorksClient()
  return (
    <DialogFooter>
      {editingKey && keySaved && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="sm:me-auto"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await actions.disconnectComposio()
              onClose()
            })
          }
        >
          Remove key
        </Button>
      )}
      {!editingKey && (
        <Button type="button" variant="ghost" size="sm" className="sm:me-auto" disabled={pending} onClick={() => onEditKey()}>
          Composio key
        </Button>
      )}
      {connected && !editingKey ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await actions.composioUnlink(c.toolkit)
                onClose()
              })
            }
          >
            Disconnect
          </Button>
          <DialogClose render={<Button type="button" size="sm" />}>Done</DialogClose>
        </>
      ) : (
        <>
          <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
          {editingKey ? (
            <Button type="submit" size="sm" disabled={pending || !canSaveKey}>
              {pending ? 'Checking…' : 'Save key'}
            </Button>
          ) : link ? (
            <Button type="button" size="sm" nativeButton={false} render={<a href={link} target="_blank" rel="noreferrer" />}>
              Open sign-in page
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Opening…' : `Sign in to ${c.name}`}
            </Button>
          )}
        </>
      )}
    </DialogFooter>
  )
}

/** Opens a remote server's OAuth sign-in in the browser; the row turns to "Signed in" when the callback lands (a settings event). */
async function signIn(actions: ReturnType<typeof useDorksClient>['actions'], name: string) {
  const { url } = await actions.mcpSignIn(name)
  window.open(url, '_blank', 'noopener,noreferrer')
}

function ServerRow({ server: s, onEdit }: { server: McpServerView; onEdit: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const secrets = [...s.headerNames, ...s.envNames]
  const where = s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')
  return (
    <SettingsRow
      label={<code className="font-mono text-xs">{s.name}</code>}
      description={
        <span className="block truncate">
          <span className="font-mono">{where}</span>
          {secrets.length > 0 && <span> · {secrets.join(', ')}</span>}
          {s.oauth === 'signed_in' && <span> · Signed in</span>}
          {s.oauth === 'signed_out' && <span> · Agents get it once you sign in</span>}
          {error && <span className="text-destructive"> · {error}</span>}
        </span>
      }
      control={
        <>
          {s.oauth === 'signed_out' && (
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void run(() => signIn(actions, s.name))}>
              Sign in
            </Button>
          )}
          {s.oauth === 'signed_in' && (
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void run(() => actions.mcpSignOut(s.name))}>
              Sign out
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`remove ${s.name}`} disabled={pending} onClick={() => void run(() => actions.deleteMcpServer(s.name))}>
            Remove
          </Button>
        </>
      }
    />
  )
}

function ServerDialog({ initial, onClose }: { initial: Draft; onClose: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [d, setD] = useState(initial)
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }))
  const http = d.transport === 'http'
  const pairs = http ? d.headers : d.env
  const setPairs = (next: Pair[]) => set(http ? { headers: next } : { env: next })

  const ready = !!d.name.trim() && (http ? !!d.url.trim() : !!d.command.trim()) && pairs.every((p) => !p.key.trim() || p.value || p.saved)
  const submit = () =>
    void run(async () => {
      const values = Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value || (p.saved ? null : '')]))
      const input: McpServerInput = http
        ? { transport: 'http', url: d.url.trim(), headers: values }
        : { transport: 'stdio', command: d.command.trim(), args: d.args.split('\n').filter((a, i, all) => a !== '' || i < all.length - 1), env: values }
      const { oauth } = await actions.putMcpServer(d.name.trim(), input)
      if (oauth === 'signed_out') await signIn(actions, d.name.trim())
      onClose()
    })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex max-h-[85vh] flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{d.editing ? `Edit ${d.name}` : 'Add a custom connector'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {
                'A remote connector speaks HTTP; one that asks for a sign-in opens it in your browser when you save. A local one is a command each sandbox runs. Values are stored encrypted and never shown again.'
              }
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="min-h-0 overflow-y-auto">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                <Input id="mcp-name" className="font-mono" placeholder="linear" disabled={d.editing} value={d.name} onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
                <FieldDescription>Agents see its tools as mcp__{d.name.trim() || 'name'}__*.</FieldDescription>
              </Field>
              {
                <Field>
                  <FieldLabel htmlFor="mcp-transport">Type</FieldLabel>
                  <NativeSelect id="mcp-transport" value={d.transport} onChange={(e) => set({ transport: e.target.value as Draft['transport'] })}>
                    <NativeSelectOption value="http">Remote (HTTP)</NativeSelectOption>
                    <NativeSelectOption value="stdio">Local command</NativeSelectOption>
                  </NativeSelect>
                </Field>
              }
              {http ? (
                <Field>
                  <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
                  <Input id="mcp-url" placeholder="https://mcp.example.com/mcp" value={d.url} onChange={(e) => set({ url: e.target.value })} />
                </Field>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
                    <Input id="mcp-command" className="font-mono" placeholder="npx" value={d.command} onChange={(e) => set({ command: e.target.value })} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-args">Arguments</FieldLabel>
                    <Textarea id="mcp-args" rows={3} className="font-mono" placeholder={'-y\n@modelcontextprotocol/server-memory'} value={d.args} onChange={(e) => set({ args: e.target.value })} />
                    <FieldDescription>One per line, exactly as written.</FieldDescription>
                  </Field>
                </>
              )}
              <PairsField label={http ? 'Headers' : 'Environment'} keyPlaceholder={http ? 'Authorization' : 'API_TOKEN'} pairs={pairs} onChange={setPairs} />
            </FieldGroup>
            {error && (
              <p role="alert" className="mt-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !ready}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PairsField({ label, keyPlaceholder, pairs, onChange }: { label: string; keyPlaceholder: string; pairs: Pair[]; onChange: (next: Pair[]) => void }) {
  const edit = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input aria-label={`${label} name`} className="min-w-0 flex-1 font-mono" placeholder={keyPlaceholder} value={p.key} onChange={(e) => edit(i, { key: e.target.value, saved: false })} />
          <Input
            aria-label={`${label} value`}
            className="min-w-0 flex-1"
            type="password"
            autoComplete="off"
            placeholder={p.saved ? 'Saved' : 'Value'}
            value={p.value}
            onChange={(e) => edit(i, { value: e.target.value })}
          />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`remove ${p.key || 'entry'}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <XIcon />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...pairs, { key: '', value: '', saved: false }])}>
          Add {label === 'Headers' ? 'header' : 'variable'}
        </Button>
      </div>
    </Field>
  )
}
