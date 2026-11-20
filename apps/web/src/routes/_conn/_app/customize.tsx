import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { XIcon } from 'lucide-react'
import type { McpServerInput, McpServerView } from '@dorks/client'
import { useDorksClient, useMcpServers } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSections } from '../../../components/settings/kit'
import { usePending } from '../../../lib/pending'

// Customize (docs/mcp.md): the owner's MCP servers. Every agent gets them, in every sandbox, next to the built-in `dorks` server.
// Header and variable values are write-only: the list shows their names, and an edit keeps a saved value unless a new one is typed.

export const Route = createFileRoute('/_conn/_app/customize')({ component: Customize })

/** What the add/edit dialog starts from: a blank server, Composio's hosted MCP, or a saved server. */
type Draft = { editing: boolean; name: string; transport: 'http' | 'stdio'; url: string; command: string; args: string; headers: Pair[]; env: Pair[] }
/** A header or variable. `saved` means the server holds a value: an empty field keeps it. */
type Pair = { key: string; value: string; saved: boolean }

const BLANK: Draft = { editing: false, name: '', transport: 'http', url: '', command: '', args: '', headers: [], env: [] }
// Composio: the URL from the dashboard (or `session.mcp.url` from its SDK), and the project's API key as `X-API-Key`.
const COMPOSIO: Draft = { ...BLANK, name: 'composio', headers: [{ key: 'X-API-Key', value: '', saved: false }] }

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
  const add = (
    <>
      <Button size="sm" variant="outline" onClick={() => setDraft(BLANK)}>
        Add server
      </Button>
      <Button size="sm" variant="outline" onClick={() => setDraft(COMPOSIO)}>
        Add Composio
      </Button>
    </>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Customize" divider={!!servers?.length} actions={servers?.length ? <div className="flex gap-2">{add}</div> : undefined} />
      {servers?.length === 0 && (
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="plug" title="No MCP servers yet" description="Servers you add here will be available to every agent, in every sandbox.">
            {add}
          </EmptyState>
        </div>
      )}
      {!!servers?.length && (
        <div className="app-main min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-160 px-4 pt-8 pb-16 sm:px-6">
            <SettingsSections>
              <SettingsSection title="MCP servers" description="Every agent gets these tools, in every sandbox. Running sessions pick up a change when their current turn ends.">
                <SettingsGroup label="mcp servers">
                  {servers.map((s) => (
                    <ServerRow key={s.name} server={s} onEdit={() => setDraft(draftOf(s))} />
                  ))}
                </SettingsGroup>
              </SettingsSection>
            </SettingsSections>
          </div>
        </div>
      )}
      {draft && <ServerDialog key={`${draft.name}:${draft.editing}`} initial={draft} onClose={() => setDraft(null)} />}
    </div>
  )
}

function ServerRow({ server: s, onEdit }: { server: McpServerView; onEdit: () => void }) {
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  const secrets = [...s.headerNames, ...s.envNames]
  const where = s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')
  return (
    <SettingsRow
      label={<code className="font-mono text-xs">{s.name}</code>}
      description={
        <span className="block truncate">
          <span className="font-mono">{where}</span>
          {secrets.length > 0 && <span> · {secrets.join(', ')}</span>}
        </span>
      }
      control={
        <>
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
  const composio = d.name === 'composio' && http

  const ready = !!d.name.trim() && (http ? !!d.url.trim() : !!d.command.trim()) && pairs.every((p) => !p.key.trim() || p.value || p.saved)
  const submit = () =>
    void run(async () => {
      const values = Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value || (p.saved ? null : '')]))
      const input: McpServerInput = http
        ? { transport: 'http', url: d.url.trim(), headers: values }
        : { transport: 'stdio', command: d.command.trim(), args: d.args.split('\n').filter((a, i, all) => a !== '' || i < all.length - 1), env: values }
      await actions.putMcpServer(d.name.trim(), input)
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
            <DialogTitle className="text-sm font-medium">{d.editing ? `Edit ${d.name}` : composio ? 'Add Composio' : 'Add an MCP server'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {composio
                ? 'Paste the MCP URL from your Composio project and its API key. Its tools reach every agent as mcp__composio__*.'
                : 'A hosted server speaks HTTP; a local one is a command each sandbox runs. Values are stored encrypted and never shown again.'}
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="min-h-0 overflow-y-auto">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                <Input id="mcp-name" className="font-mono" placeholder="linear" disabled={d.editing} value={d.name} onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
                <FieldDescription>Agents see its tools as mcp__{d.name.trim() || 'name'}__*.</FieldDescription>
              </Field>
              {!composio && (
                <Field>
                  <FieldLabel htmlFor="mcp-transport">Type</FieldLabel>
                  <NativeSelect id="mcp-transport" value={d.transport} onChange={(e) => set({ transport: e.target.value as Draft['transport'] })}>
                    <NativeSelectOption value="http">Remote (HTTP)</NativeSelectOption>
                    <NativeSelectOption value="stdio">Local command</NativeSelectOption>
                  </NativeSelect>
                </Field>
              )}
              {http ? (
                <Field>
                  <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
                  <Input id="mcp-url" placeholder={composio ? 'https://backend.composio.dev/…/mcp' : 'https://mcp.example.com/mcp'} value={d.url} onChange={(e) => set({ url: e.target.value })} />
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
