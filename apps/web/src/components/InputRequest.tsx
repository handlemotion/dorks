import { useContext, useId, useState } from 'react'
import { ArrowUpRightIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LockIcon, TimerOffIcon, XIcon } from 'lucide-react'
import type { Block, InputField } from '@dorks/shared'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@dorks/ui/input-group'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { usePending } from '../lib/pending'
import { LocalAccessContext } from './LocalRequest'

// An agent's request for values it uses without reading them (docs/secure-inputs.md): a login, a one-time code, a key. While it waits,
// a compact form; once answered, one line in the thread. The values go straight to the server and are never kept here: the form
// clears them as soon as they are sent, and nothing in the transcript ever holds one.

type InputBlock = Extract<Block, { kind: 'input' }>

export function InputRequestCard({ block }: { block: InputBlock }) {
  if (block.status === 'pending') return <InputForm block={block} />
  const icon = block.status === 'provided' ? <KeyRoundIcon /> : block.status === 'dismissed' ? <XIcon /> : <TimerOffIcon />
  const title = block.status === 'provided' ? `You provided ${block.title}` : block.status === 'dismissed' ? `You dismissed ${block.title}` : `${block.title} was not answered in time`
  return (
    <Trace data-testid="input-request" data-status={block.status} className="my-1.5">
      <TraceLine role="status" className="text-(length:--text-message)" title={block.status === 'provided' ? 'The agent can use these values but never sees them' : undefined}>
        <TraceIcon>{icon}</TraceIcon>
        <TraceTitle>{title}</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

const autoComplete = (f: InputField) => (f.kind === 'otp' ? 'one-time-code' : f.kind === 'email' ? 'username' : f.kind === 'secret' ? 'current-password' : 'off')

function InputForm({ block }: { block: InputBlock }) {
  const ctx = useContext(LocalAccessContext)
  const agent = ctx?.agent ?? 'The agent'
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [values, setValues] = useState<Record<string, string>>({})
  const ready = block.fields.every((f) => f.optional || (values[f.name] ?? '') !== '')
  const submit = () =>
    ctx &&
    void run(async () => {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
      await actions.answerInput(ctx.dorkId, block.requestId, { values: filled })
      setValues({}) // never hold a value longer than it takes to send it
    })
  const dismiss = () => ctx && void run(() => actions.answerInput(ctx.dorkId, block.requestId, { dismiss: true }))
  // The surface fill with its hairline, like the computer-access card: one padded block, no inner lines.
  return (
    <form
      role="alert"
      data-testid="input-request"
      data-status="pending"
      autoComplete="off"
      className="flex w-full min-w-0 flex-col gap-3 rounded-[6px] border border-surface-line bg-surface px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !pending) submit()
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{block.title}</p>
        {block.description && <p className="text-sm text-muted-foreground">{block.description}</p>}
      </div>
      {block.fields.map((f) => (
        <FieldInput key={f.name} field={f} labelled={block.fields.length > 1} value={values[f.name] ?? ''} disabled={pending || !ctx} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      ))}
      {ctx && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" type="submit" disabled={pending || !ready}>
            Continue
          </Button>
          <Button size="sm" type="button" variant="outline" disabled={pending} onClick={dismiss}>
            Dismiss
          </Button>
          <p className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <LockIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{agent} can use these but never sees them</span>
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

/** The link's text: the host it goes to, so the owner sees where before they click. Null for anything but https. */
const hostOf = (url: string) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

// One field: the card's title names it, so the field shows no label of its own. Several: a label each. The agent's hint is the
// input's placeholder, and under the input, apart from it, a link to the page that has the value.
function FieldInput({ field, labelled, value, disabled, onChange }: { field: InputField; labelled: boolean; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = useId()
  const [shown, setShown] = useState(false)
  const masked = field.kind === 'secret' && !shown
  const host = field.url ? hostOf(field.url) : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {labelled && (
        <label htmlFor={id} className="text-sm text-foreground">
          {field.label}
          {field.optional && <span className="text-muted-foreground"> (optional)</span>}
        </label>
      )}
      <InputGroup className="h-8 rounded-(--control-radius) border-input bg-background">
        <InputGroupInput
          id={id}
          name={field.name}
          aria-label={labelled ? undefined : field.label}
          placeholder={field.description}
          title={field.description}
          type={field.kind === 'email' ? 'email' : masked ? 'password' : 'text'}
          inputMode={field.kind === 'otp' ? 'numeric' : undefined}
          autoComplete={autoComplete(field)}
          spellCheck={false}
          autoCapitalize="off"
          required={!field.optional}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={field.kind === 'otp' ? 'font-mono text-sm tracking-widest' : 'text-sm'}
        />
        {field.kind === 'secret' && (
          <InputGroupAddon align="inline-end" className="pr-[3px] has-[>button]:mr-0">
            <InputGroupButton
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={shown ? `Hide ${field.label}` : `Show ${field.label}`}
              aria-pressed={shown}
              onClick={() => setShown((s) => !s)}
              className="rounded-[6px] text-muted-foreground hover:text-foreground"
            >
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      {host && (
        <a
          href={field.url}
          target="_blank"
          rel="noreferrer"
          title={field.url}
          className="mt-1 inline-flex w-fit items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {host}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      )}
    </div>
  )
}
