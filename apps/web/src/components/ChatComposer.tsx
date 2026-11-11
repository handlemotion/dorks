import { ArrowUpIcon, BoxIcon, ChevronDownIcon, FolderIcon, LoaderCircleIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import type { AgentModelChoice } from '@dorks/shared'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { Input } from '@dorks/ui/input'
import { Button } from '@dorks/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import claudeLogo from '../assets/providers/claude.svg'
import openaiDark from '../assets/providers/openai-dark.svg'
import openaiLight from '../assets/providers/openai-light.svg'
import { Logo } from './onboarding/List'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@dorks/ui/input-group'
import { Tip } from './Tip'

export type AgentProvider = 'codex' | 'claude'

const AGENT_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  // svgl pads the OpenAI mark inside its viewBox, so it is scaled to sit at Claude's size.
  return provider === 'claude' ? <Logo light={claudeLogo} className="size-3.5" /> : <Logo light={openaiLight} dark={openaiDark} className="size-3.5 scale-[1.3]" />
}

/** The effort as signal bars: `level` of three filled, the rest faint. */
function EffortBars({ level }: { level: number }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="size-3.5">
      {[6, 9, 12].map((h, i) => (
        <rect key={h} x={1 + i * 4.5} y={13 - h} width={3} height={h} rx={0.75} fill="currentColor" opacity={i < level ? 1 : 0.25} />
      ))}
    </svg>
  )
}
/** The main button (send or stop) is the one brand-blue action. */
// Disabled: a quiet grey disc with a dimmed arrow, not faded blue.
const MAIN = 'size-7 rounded-(--control-radius) [--control-radius:6px] [&_svg]:size-3.5 bg-brand text-brand-foreground hover:bg-brand-hover disabled:bg-foreground/[0.08] disabled:text-foreground/35 disabled:opacity-100'
const EFFORT_NAMES: Record<string, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const DEFAULT = 'default'
/** An effort among the model's as one to three bars. */
const barsFor = (efforts: string[], effort: string) => Math.max(1, Math.ceil(((efforts.indexOf(effort) + 1) / efforts.length) * 3))

/**
 * The Claude model menu's state. `choices` are the models the agent itself reported (the CLI's own list, never one kept here);
 * `model` and `effort` are the session's choice (absent: the agent's default); `active` is what the agent confirmed it runs.
 */
export interface ModelPicker {
  choices: AgentModelChoice[]
  model?: string
  effort?: string
  active?: { model?: string; effort?: string }
  onChange: (model: string | undefined, effort: string | undefined) => void
}

/** The agent's own name for a model id or alias, preferring a concrete model over the `default` alias. */
function modelName(choices: AgentModelChoice[], id: string | undefined): string | undefined {
  if (!id) return undefined
  const resolved = choices.find((c) => c.model === id)?.resolved ?? id
  const named = choices.find((c) => c.model !== DEFAULT && (c.resolved ?? c.model) === resolved) ?? choices.find((c) => c.model === id)
  return named?.name ?? (id === DEFAULT ? undefined : id)
}

/** An attached image: shown at once from a local object URL while it uploads; `imageId` is the server's once it has. */
type Pending = { key: string; name: string; preview: string; state: 'uploading' | 'done' | 'error'; imageId?: string }
/** What a sent message names: the server ids of its attached images. */
export type AttachedImage = { id: string; name: string }
/** The markdown that puts attached images in a message; the chat shows them as thumbnails and the agent gets them as images. */
export const withImages = (text: string, images: AttachedImage[]) =>
  [text.trim(), ...images.map((i) => `![${i.name.replace(/[[\]\n]/g, ' ')}](dorks-image:${i.id})`)].filter(Boolean).join('\n\n')
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE = 8 * 1024 * 1024

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui): the box holds the text, attachments and main button; the compact bar below holds the repository
 * and one menu for the model (by agent) and the effort. The main button sends, or stops the agent while it is working. With `setRepo` it is the "new session" form (the first
 * message also names the repository). Claude's models and efforts are the ones the agent reported; images are attached with the + button, by pasting or by dropping them on the box.
 */
export function Composer({
  text,
  setText,
  onSubmit,
  pending,
  disabled,
  error,
  repo,
  setRepo,
  repositories = [],
  provider = 'claude',
  setProvider,
  codexEnabled,
  onStop,
  status,
  picker,
  agentLabel,
  upload,
  machine,
}: {
  text: string
  setText: (text: string) => void
  /** Resolves once sent; the attachments are cleared then, and kept if it throws or resolves `false`. */
  onSubmit: (images: AttachedImage[]) => void | Promise<unknown>
  pending: boolean
  disabled?: boolean
  error: string
  repo?: string
  setRepo?: (repo: string) => void
  repositories?: string[]
  provider?: AgentProvider
  /** Without it the agent is fixed (a running session): the menu shows it but only the effort can change. */
  setProvider?: (provider: AgentProvider) => void
  /** Codex only shows up as a choice when a Boat ChatGPT environment is configured. Claude Code is the default. */
  codexEnabled?: boolean
  /** Set while the agent is working: the main button becomes Stop. */
  onStop?: () => void
  /** A line above the box, e.g. the sandbox status. */
  status?: ReactNode
  /** Claude's model and effort. */
  picker?: ModelPicker
  /** What to call the agent's model when there is no picker (Codex). */
  agentLabel?: string
  /** Uploads an attached image, resolving with its server id. Without it nothing can be attached. */
  upload?: (file: File) => Promise<string>
  /** The build a new session starts on (docs/builds.md); shown once there is a built one. */
  machine?: MachinePicker
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [files, setFiles] = useState<Pending[]>([])
  const [attachError, setAttachError] = useState('')
  const filesRef = useRef(files)
  filesRef.current = files
  useEffect(() => () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.preview)), [])
  const attach = (list: File[]) => {
    if (!upload) return
    const images = list.filter((f) => IMAGE_TYPES.includes(f.type))
    const tooBig = images.filter((f) => f.size > MAX_IMAGE)
    setAttachError(images.length < list.length ? 'Only PNG, JPEG, WebP and GIF images can be attached.' : tooBig.length ? 'Images can be at most 8 MB.' : '')
    for (const file of images.filter((f) => f.size <= MAX_IMAGE)) {
      const key = crypto.randomUUID()
      setFiles((current) => [...current, { key, name: file.name || 'Pasted image', preview: URL.createObjectURL(file), state: 'uploading' }])
      upload(file).then(
        (imageId) => setFiles((current) => current.map((f) => (f.key === key ? { ...f, state: 'done', imageId } : f))),
        () => setFiles((current) => current.map((f) => (f.key === key ? { ...f, state: 'error' } : f))),
      )
    }
  }
  const remove = (key: string) => setFiles((current) => current.filter((f) => {
    if (f.key === key) URL.revokeObjectURL(f.preview)
    return f.key !== key
  }))
  const ready = files.filter((f) => f.state === 'done' && f.imageId)
  const uploading = files.some((f) => f.state === 'uploading')
  // One row until the text wraps (or a file is attached); then the text takes the box and the buttons sit on a row under it.
  // The text has the same side insets in both forms, so it wraps the same way in each and the box never flips back and forth.
  const [wraps, setWraps] = useState(false)
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return
    const measure = () => {
      const style = getComputedStyle(el)
      const content = el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      setWraps(content > parseFloat(style.lineHeight) * 1.5)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  const stacked = wraps || files.length > 0
  const isNewSession = setRepo !== undefined
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !pending && !disabled && (!isNewSession || !!repo?.trim())
  const submit = async () => {
    const sent = files
    try {
      if ((await onSubmit(ready.map((f) => ({ id: f.imageId!, name: f.name })))) === false) return
    } catch {
      return
    }
    // Only what was sent goes: an image attached while it was sending stays for the next message.
    setFiles((current) => current.filter((f) => !sent.includes(f)))
    sent.forEach((f) => URL.revokeObjectURL(f.preview))
    setAttachError('')
  }
  const models = provider === 'claude' ? picker : undefined
  const choices = models?.choices ?? []
  // The trigger names the model the agent confirmed when it has, else the one chosen (or what the default resolves to).
  const active = models?.active?.model ? models.active : undefined
  const modelLabel = (models && (modelName(choices, active?.model) ?? modelName(choices, models.model ?? DEFAULT))) || agentLabel || AGENT_NAMES[provider]
  const effort = active ? active.effort : models?.effort
  const selected = choices.find((c) => c.model === (models?.model ?? DEFAULT))
  const efforts: string[] = selected?.efforts ?? []
  return (
    // The prompt input is published with an 18px group and pill buttons; the app's 6px radius is lifted for it alone.
    <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 px-5 pb-3 [--control-radius:18px]">
      {status}
      <form
        ref={formRef}
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); if (canSend) void submit() }}
        onDragOver={(e) => { if (upload && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDrop={(e) => {
          if (!upload || !e.dataTransfer.files.length) return
          e.preventDefault()
          attach(Array.from(e.dataTransfer.files))
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            // Copied before the input is cleared: the FileList is live and empties with it.
            attach(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        {/* White on the off-white app (light), with the panel's 6% hairline since that pair is under 1.15:1; dark keeps the published fill. */}
        <InputGroup className="rounded-[15px] border-border bg-white has-[textarea]:rounded-[15px] has-[>[data-align=block-start]]:rounded-[15px] dark:border-transparent dark:bg-input/50">
          {files.length > 0 ? (
            // Attached images as plain thumbnails, the text's left edge, no file names: a 112px tile with the image filling it, a hairline
            // drawn inside its edge so a white screenshot keeps its shape, and a remove button in its corner on hover or focus.
            <InputGroupAddon align="block-start" className="flex-wrap justify-start gap-2 px-[42px] pt-3 pb-0">
              {files.map((file) => (
                <div
                  key={file.key}
                  data-testid="composer-attachment"
                  data-state={file.state}
                  title={file.state === 'error' ? `${file.name}: upload failed` : file.name}
                  className="group/tile relative size-28 shrink-0 overflow-hidden rounded-[10px] bg-muted"
                >
                  <img src={file.preview} alt={file.name} className={`size-full object-cover object-top ${file.state === 'done' ? '' : 'opacity-50'}`} />
                  <span aria-hidden className={`pointer-events-none absolute inset-0 rounded-[10px] outline outline-1 -outline-offset-1 ${file.state === 'error' ? 'outline-destructive' : 'outline-black/10 dark:outline-white/10'}`} />
                  {file.state === 'uploading' && <LoaderCircleIcon aria-label="Uploading" className="absolute inset-0 m-auto size-5 animate-spin text-foreground" />}
                  {file.state === 'error' && <span role="alert" className="absolute inset-x-0 bottom-0 bg-destructive px-2 py-1 text-xs text-white">Upload failed</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => remove(file.key)}
                    className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 outline-none transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            aria-label={isNewSession ? 'first message' : 'message'}
            // Not a credential field: keep Safari's and password managers' autofill off it.
            name="prompt"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            placeholder="Ask the agent to change your code..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
              if (!upload || !images.length) return
              e.preventDefault()
              attach(images)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
            disabled={pending || disabled}
            ref={textRef}
            rows={1}
            // A 44px row: 12px above and below a 20px line, the text 42px in from each side (past the 28px buttons, 8px from the
            // edge, and 6px more). Stacked, the bottom inset makes room for the button row (16px gap, 28px button, 8px edge).
            className={`max-h-[40vh] min-h-0 py-3 px-[42px] leading-5 ${stacked ? 'pb-13' : ''}`}
          />
          {/* Attach and the main button keep one spot, 8px from the bottom corners, whether the box is one row or stacked. */}
          <div className="absolute bottom-2 left-2">
            <Tip label="Attach images">
              <InputGroupButton size="icon-sm" variant="ghost" className="size-7 text-muted-foreground hover:text-foreground [--control-radius:6px]" aria-label="Attach images" disabled={!upload || pending || disabled} onClick={() => fileRef.current?.click()}>
                <PlusIcon className="size-4" />
              </InputGroupButton>
            </Tip>
          </div>
          <div className="absolute right-2 bottom-2">
            {onStop ? (
              <Tip label="Stop agent">
                <InputGroupButton size="icon-sm" variant="default" className={MAIN} aria-label="Stop agent" onClick={onStop}>
                  <SquareIcon className="fill-current" />
                </InputGroupButton>
              </Tip>
            ) : (
              <Tip label={isNewSession ? 'Create session' : 'Send message'}>
                <InputGroupButton type="submit" size="icon-sm" variant="default" className={MAIN} aria-label={isNewSession ? 'Create session' : 'Send message'} disabled={!canSend}>
                  {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
                </InputGroupButton>
              </Tip>
            )}
          </div>
        </InputGroup>
        {/* Compact, shared baseline for the repository and model controls. */}
        <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] [--control-radius:6px]">
          {repo !== undefined && (setRepo ? (
            <RepositoryPicker repo={repo} setRepo={setRepo} repositories={repositories} disabled={pending || disabled} />
          ) : (
            <span title={repo} data-testid="chat-repository" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="max-w-48 truncate">{repo || 'No repository'}</span>
            </span>
          ))}
          {machine && machine.builds.length > 0 && <MachineMenu machine={machine} disabled={pending || disabled} />}
          <DropdownMenu>
            <DropdownMenuTrigger disabled={pending || disabled} render={<InputGroupButton size="sm" variant="ghost" aria-label={`Model: ${modelLabel}${effort ? `, effort: ${EFFORT_NAMES[effort] ?? effort}` : ''}`} className="ml-auto h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" />}>
              <span data-testid="model-label">{modelLabel}</span>
              {effort && efforts.length > 0 && <span className="text-muted-foreground"><EffortBars level={barsFor(efforts, effort)} /></span>}
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{AGENT_NAMES.claude}</DropdownMenuLabel>
                {provider === 'claude' && models && choices.length > 0 ? (
                  <DropdownMenuRadioGroup
                    value={models.model ?? DEFAULT}
                    onValueChange={(value) => {
                      const next = choices.find((c) => c.model === value)
                      // An effort the new model does not support falls back to its default.
                      models.onChange(value === DEFAULT ? undefined : value, models.effort && next?.efforts.includes(models.effort as never) ? models.effort : undefined)
                    }}
                  >
                    {choices.map((c) => (
                      <DropdownMenuRadioItem key={c.model} value={c.model} closeOnClick title={c.description}>
                        <ProviderIcon provider="claude" />
                        <span className="min-w-0 truncate">{c.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('claude')}>
                    <DropdownMenuRadioItem value="claude" closeOnClick disabled={provider !== 'claude' && !setProvider}>
                      <ProviderIcon provider="claude" />
                      {provider === 'claude' ? modelLabel : AGENT_NAMES.claude}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                )}
              </DropdownMenuGroup>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{AGENT_NAMES.codex}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('codex')}>
                  <DropdownMenuRadioItem value="codex" closeOnClick disabled={provider !== 'codex' && (!setProvider || !codexEnabled)}>
                    <ProviderIcon provider="codex" />
                    {provider === 'codex' ? modelLabel : AGENT_NAMES.codex}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              {models && efforts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Effort</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={models.effort ?? DEFAULT} onValueChange={(value) => models.onChange(models.model, value === DEFAULT ? undefined : value)}>
                      <DropdownMenuRadioItem value={DEFAULT} closeOnClick>
                        <EffortBars level={0} />
                        Default
                      </DropdownMenuRadioItem>
                      {efforts.map((e) => (
                        <DropdownMenuRadioItem key={e} value={e} closeOnClick>
                          <EffortBars level={barsFor(efforts, e)} />
                          {EFFORT_NAMES[e] ?? e}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </>
              )}
              {models && !isNewSession && (
                <>
                  <DropdownMenuSeparator />
                  {/* What the agent itself reported, so the trigger is never only what was asked for. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="font-normal text-muted-foreground" data-testid="model-confirmation">
                      {active
                        ? <span>Running <span className="font-mono">{active.model}</span>{active.effort ? ` at ${(EFFORT_NAMES[active.effort] ?? active.effort).toLowerCase()} effort` : ''}.</span>
                        : 'Applies from your next message.'}
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </form>
      {(error || attachError) && <p className="px-3 text-sm text-destructive" role="alert">{error || attachError}</p>}
    </div>
  )
}

export interface MachinePicker {
  /** Builds with an image; the base machine is always offered too. */
  builds: { id: string; name: string }[]
  /** null: the base machine. */
  buildId: string | null
  onChange: (buildId: string | null) => void
}

/** Which machine a new session starts on: a build, or the base. */
function MachineMenu({ machine, disabled }: { machine: MachinePicker; disabled?: boolean }) {
  const BASE = '__base__'
  const name = machine.builds.find((b) => b.id === machine.buildId)?.name ?? 'Base machine'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} render={<InputGroupButton size="sm" variant="ghost" aria-label={`Machine: ${name}`} className="h-7 min-w-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" />}>
        <BoxIcon className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate" data-testid="machine-label">{name}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Machine</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={machine.buildId ?? BASE} onValueChange={(v) => machine.onChange(v === BASE ? null : v)}>
            {machine.builds.map((b) => (
              <DropdownMenuRadioItem key={b.id} value={b.id} closeOnClick>
                <span className="min-w-0 truncate">{b.name}</span>
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value={BASE} closeOnClick>Base machine</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Recent repositories are shortcuts; entering owner/repo also works for a first session. */
function RepositoryPicker({ repo, setRepo, repositories, disabled }: { repo: string; setRepo: (repo: string) => void; repositories: string[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(repo)
  const choose = (value: string) => { setRepo(value.trim()); setOpen(false) }
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(repo) }}>
      <PopoverTrigger disabled={disabled} render={<InputGroupButton size="sm" variant="ghost" className="h-7 min-w-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" aria-label={`Repository: ${repo || 'Choose repository'}`} title={repo} />}>
        <FolderIcon />
        <span className="max-w-48 truncate">{repo || 'Choose repository'}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className="gap-2 border border-border p-2">
        <label htmlFor="new-session-repo" className="px-1 text-xs text-muted-foreground">Repository</label>
        <Input id="new-session-repo" aria-label="repo" autoComplete="off" placeholder="owner/repo" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (draft.trim()) choose(draft) }
        }} />
        {repositories.length > 0 && <div className="flex max-h-44 flex-col overflow-y-auto">
          {repositories.map((value) => <Button key={value} variant="ghost" size="sm" className="justify-start" onClick={() => choose(value)}><FolderIcon /><span className="truncate">{value}</span></Button>)}
        </div>}
        <Button size="sm" variant="outline" disabled={!draft.trim()} onClick={() => choose(draft)}>Use repository</Button>
      </PopoverContent>
    </Popover>
  )
}
