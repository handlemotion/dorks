import { ArrowUpIcon, BoxIcon, ChevronDownIcon, FolderIcon, LoaderCircleIcon, PlusIcon, SparkleIcon, SquareIcon, SquareTerminalIcon, XIcon, ZapIcon } from 'lucide-react'
import { modelLabel, type AgentModelChoice } from '@dorks/shared'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Command, CommandEmpty, CommandItem, CommandMenuInput, CommandList, CommandSeparator } from '@dorks/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import claudeLogo from '../assets/providers/claude.svg'
import openaiDark from '../assets/providers/openai-dark.svg'
import openaiLight from '../assets/providers/openai-light.svg'
import { Logo } from './onboarding/List'
import { OwnerAvatar, ownerOf } from './RepoAvatar'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@dorks/ui/input-group'
import { Tip } from './Tip'
import { ImageLightbox, ImageTrigger } from './ImageLightbox'
import { ReplyBanner, SEND_KEY } from './Reply'
import { addDropZone, dropZoneFor } from '../lib/fileDrop'
import type { Reply } from '../lib/reply'

export type AgentProvider = 'codex' | 'claude' | 'opencode' | 'antigravity'

const AGENT_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

export function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'opencode') return <SquareTerminalIcon className="size-3.5" />
  if (provider === 'antigravity') return <SparkleIcon className="size-3.5" />
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
const MAIN =
  'size-7 rounded-(--control-radius) [--control-radius:6px] [&_svg]:size-3.5 bg-brand text-brand-foreground hover:bg-brand-hover disabled:bg-foreground/[0.08] disabled:text-foreground/35 disabled:opacity-100'
const EFFORT_NAMES: Record<string, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const DEFAULT = 'default'
/** The model a new session starts on when nothing else is chosen: Opus, the family's current version. */
export const PREFERRED = 'opus'
/** Opus when the agent offers it; otherwise nothing, the CLI's own default. */
export const preferredModel = (choices: readonly AgentModelChoice[]) => (choices.some((c) => c.model === PREFERRED) ? PREFERRED : undefined)
/** An effort among the model's as one to three bars. */
const barsFor = (efforts: string[], effort: string) => Math.max(1, Math.ceil(((efforts.indexOf(effort) + 1) / efforts.length) * 3))

/**
 * The Claude model menu's state. `choices` are the models the agent itself reported (the CLI's own list, never one kept here);
 * `model`, `effort` and `fast` are the session's choice (absent: the agent's default, fast mode off); `active` is what the agent
 * confirmed it runs.
 */
export interface ModelPicker {
  choices: AgentModelChoice[]
  model?: string
  effort?: string
  fast?: boolean
  active?: { model?: string; effort?: string }
  onChange: (model: string | undefined, effort: string | undefined, fast: boolean) => void
}

/** The agent's own name for a model id or alias, preferring a concrete model over the `default` alias. */
function modelName(choices: AgentModelChoice[], id: string | undefined): string | undefined {
  if (!id) return undefined
  const resolved = choices.find((c) => c.model === id)?.resolved ?? id
  const named = choices.find((c) => c.model !== DEFAULT && (c.resolved ?? c.model) === resolved) ?? choices.find((c) => c.model === id)
  return named ? modelLabel(named) : id === DEFAULT ? undefined : id
}

/** An attached image: shown at once from a local object URL while it uploads; `imageId` is the server's once it has. */
type Pending = { key: string; name: string; preview: string; state: 'uploading' | 'done' | 'error'; imageId?: string }
/** What a sent message names: the server ids of its attached images. */
export type AttachedImage = { id: string; name: string }
/** The markdown that puts attached images in a message; the chat shows them as thumbnails and the agent gets them as images. */
export const withImages = (text: string, images: AttachedImage[]) => [text.trim(), ...images.map((i) => `![${i.name.replace(/[[\]\n]/g, ' ')}](dorks-image:${i.id})`)].filter(Boolean).join('\n\n')
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE = 8 * 1024 * 1024

/**
 * The images attached to each composer's next message, by draft key (a chat's id, `new` for the new session form): kept outside the
 * component like the text draft, so they are still attached after visiting another chat, and an upload that ends meanwhile still lands
 * in its own draft. In memory only: a reload drops them (their previews are local object URLs).
 */
const attachmentDrafts = new Map<string, Pending[]>()
const draftListeners = new Set<() => void>()
const NO_FILES: Pending[] = []
const subscribeDrafts = (listener: () => void) => {
  draftListeners.add(listener)
  return () => void draftListeners.delete(listener)
}
function updateDraft(key: string, next: (current: Pending[]) => Pending[]) {
  const files = next(attachmentDrafts.get(key) ?? NO_FILES)
  if (files.length) attachmentDrafts.set(key, files)
  else attachmentDrafts.delete(key)
  draftListeners.forEach((listener) => listener())
}

/** Images attached to the next message: added, uploaded at once, removed, and cleared once sent. Kept per `draftKey` across visits. */
function useAttachments(upload: ((file: File) => Promise<string>) | undefined, draftKey: string | undefined) {
  const ownKey = useId()
  const key = draftKey ?? ownKey
  const files = useSyncExternalStore(subscribeDrafts, () => attachmentDrafts.get(key) ?? NO_FILES)
  const setFiles = (next: (current: Pending[]) => Pending[]) => updateDraft(key, next)
  const [attachError, setAttachError] = useState('')
  // Without a draft key nothing outlives the composer.
  useEffect(() => (draftKey === undefined ? () => setFiles(() => []) : undefined), [key])
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
  const remove = (key: string) =>
    setFiles((current) =>
      current.filter((f) => {
        if (f.key === key) URL.revokeObjectURL(f.preview)
        return f.key !== key
      }),
    )
  /** Only what was sent goes: an image attached while it was sending stays for the next message. */
  const clearSent = (sent: Pending[]) => {
    setFiles((current) => current.filter((f) => !sent.includes(f)))
    sent.forEach((f) => URL.revokeObjectURL(f.preview))
    setAttachError('')
  }
  const ready = files.filter((f) => f.state === 'done' && f.imageId)
  const uploading = files.some((f) => f.state === 'uploading')
  return { files, attachError, attach, remove, clearSent, ready, uploading }
}

/**
 * Files dragged into the window (from Finder or another app) go to `attach` wherever they are dropped, so the whole chat is the drop
 * target; returns whether files are being dragged toward this box, to highlight it. With several composers on screen (a crew's worker
 * panel beside its chat) a drop goes to the nearest one only (lib/fileDrop.ts). While not `enabled` nothing is taken, and a dropped
 * file is still kept from replacing the page.
 */
function useFileDrop(attach: (files: File[]) => void, enabled: boolean, formRef: RefObject<HTMLFormElement | null>) {
  const [dragging, setDragging] = useState(false)
  const attachRef = useRef(enabled ? attach : undefined)
  attachRef.current = enabled ? attach : undefined
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const mine = (e: DragEvent) => !!attachRef.current && !!formRef.current && dropZoneFor(e.target) === formRef.current
    const unregister = addDropZone({ form: () => formRef.current, enabled: () => !!attachRef.current, attach: (files) => attachRef.current?.(files) })
    // dragenter/dragleave fire for every child crossed; the count is back at 0 only once the drag has left the window.
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(mine(e))
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const own = mine(e)
      setDragging(own)
      // Each composer sees the event; only the one that would take the file says what happens to it.
      if (e.dataTransfer && (own || !dropZoneFor(e.target))) e.dataTransfer.dropEffect = own ? 'copy' : 'none'
    }
    const drop = (e: DragEvent) => {
      depth = 0
      setDragging(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length && mine(e)) attachRef.current?.(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      unregister()
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [formRef])
  return dragging && enabled
}

/** One attached image: a 112px tile with the image filling it (a click opens it in the composer's lightbox), its upload state, and a remove button. */
function AttachmentTile({ file, index, onRemove }: { file: Pending; index: number; onRemove: () => void }) {
  const failed = file.state === 'error'
  return (
    <div
      data-testid="composer-attachment"
      data-state={file.state}
      title={failed ? `${file.name}: upload failed` : file.name}
      className="group/tile relative size-28 shrink-0 overflow-hidden rounded-[10px] bg-muted"
    >
      <ImageTrigger index={index} aria-label={`Open ${file.name}`} className="block size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        {({ imageRef, morphRef }) => (
          <img
            ref={(node) => {
              imageRef(node)
              morphRef(node)
            }}
            src={file.preview}
            alt={file.name}
            className={`size-full object-cover object-top ${file.state === 'done' ? '' : 'opacity-50'}`}
          />
        )}
      </ImageTrigger>
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-[10px] outline outline-1 -outline-offset-1 ${failed ? 'outline-destructive' : 'outline-black/10 dark:outline-white/10'}`}
      />
      {file.state === 'uploading' && <LoaderCircleIcon aria-label="Uploading" className="absolute inset-0 m-auto size-5 animate-spin text-foreground" />}
      {failed && (
        <span role="alert" className="absolute inset-x-0 bottom-0 bg-destructive px-2 py-1 text-xs text-white">
          Upload failed
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 outline-none transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

/** The main button: Stop while the agent works, else send (or create the session). */
/** Enter sends (steering a running turn); ⌘ Enter (Ctrl Enter) queues for after the turn when `queue` is given; Shift Enter is a new line. */
function onEnter(e: KeyboardEvent<HTMLTextAreaElement>, send: () => void, onQueue: unknown, queue: () => void) {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
  e.preventDefault()
  if ((e.metaKey || e.ctrlKey) && onQueue) queue()
  else send()
}

/**
 * Queued messages head a muted frame the white box sits in, card on card like a fenced code block (the box overlaps the frame's
 * hairline on three sides): rows joined to the composer, not the reply banner's cards. Without a queue, just the box.
 */
function QueueFrame({ queued, children }: { queued?: ReactNode; children: ReactNode }) {
  if (!queued) return children
  return (
    <div data-queue className="flex flex-col rounded-[16px] border border-border bg-muted dark:bg-card">
      {queued}
      {children}
    </div>
  )
}

function MainButton({ onStop, isNewSession, pending, canSend, canQueue }: { onStop?: () => void; isNewSession: boolean; pending: boolean; canSend: boolean; canQueue: boolean }) {
  // While the agent works the button is Stop, until there is something to send: then it sends now, steering the turn.
  if (onStop && !canSend) {
    return (
      <Tip label="Stop agent">
        <InputGroupButton size="icon-sm" variant="default" className={MAIN} aria-label="Stop agent" onClick={onStop}>
          <SquareIcon className="fill-current" />
        </InputGroupButton>
      </Tip>
    )
  }
  const label = isNewSession ? 'Create session' : onStop ? (canQueue ? `Steer now (${SEND_KEY} Enter queues it instead)` : 'Steer now') : 'Send message'
  return (
    <Tip label={label}>
      <InputGroupButton type="submit" size="icon-sm" variant="default" className={MAIN} aria-label={label} disabled={!canSend}>
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
      </InputGroupButton>
    </Tip>
  )
}

/** The repository: a picker for a new session, else its name. */
/** The box's hint: what the session's agent is asked for. */
const hintOf = (placeholder?: string) => placeholder ?? 'Ask the agent to change your code...'

function RepositoryControl({ repo, setRepo, repositories, disabled, hidden }: { repo?: string; setRepo?: (repo: string) => void; repositories: string[]; disabled: boolean; hidden?: boolean }) {
  if (hidden) return null
  if (repo === undefined) return null
  if (setRepo) return <RepositoryPicker repo={repo} setRepo={setRepo} repositories={repositories} disabled={disabled} />
  return (
    <span title={repo} data-testid="chat-repository" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
      {repo ? <OwnerAvatar owner={ownerOf(repo)} size={16} className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
      <span className="max-w-48 truncate">{repo || 'No repository'}</span>
    </span>
  )
}

const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort

/** What the model menu shows: the model picker (Claude, OpenCode and Antigravity), the trigger's label, and the efforts the chosen model has. */
function modelMenuState(provider: AgentProvider, picker: ModelPicker | undefined, agentLabel: string | undefined) {
  const models = provider !== 'codex' ? picker : undefined
  const choices = models?.choices ?? []
  // The trigger names the model the agent confirmed when it has, else the one chosen (or what the default resolves to).
  const active = models?.active?.model ? models.active : undefined
  const chosen = models && (modelName(choices, active?.model) ?? modelName(choices, models.model ?? DEFAULT))
  const label = chosen || agentLabel || AGENT_NAMES[provider]
  const effort = active ? active.effort : models?.effort
  const choice = choices.find((c) => c.model === (models?.model ?? DEFAULT))
  const efforts: string[] = choice?.efforts ?? []
  // Fast mode only for a model that offers it.
  const fastOffered = !!choice?.fast
  const fast = fastOffered && !!models?.fast
  return { models, choices, active, label, effort, efforts, fastOffered, fast }
}

/** Claude's group: the models the agent reported, or Claude Code as a single choice. */
function ClaudeModels({
  models,
  choices,
  provider,
  setProvider,
  label,
}: {
  models?: ModelPicker
  choices: AgentModelChoice[]
  provider: AgentProvider
  setProvider?: (provider: AgentProvider) => void
  label: string
}) {
  if (provider === 'claude' && models && choices.length > 0) {
    // The CLI lists each family's current model by its alias (`opus`) and pinned older versions by full id (`claude-opus-4-8`):
    // the current ones up front, the rest (and never the one chosen) one level down.
    const chosen = models.model ?? DEFAULT
    // Dorks defaults to Opus, so the CLI's own `default` (whatever it resolves to) is listed only while a session still uses it.
    const offered = choices.filter((c) => c.model !== DEFAULT || chosen === DEFAULT || !choices.some((o) => o.model === PREFERRED))
    const latest = offered.filter((c) => !c.model.startsWith('claude-') || c.model === chosen)
    const older = offered.filter((c) => !latest.includes(c))
    return (
      <DropdownMenuRadioGroup
        value={models.model ?? DEFAULT}
        onValueChange={(value) => {
          const next = choices.find((c) => c.model === value)
          // An effort the new model does not support falls back to its default; fast mode stays on only where the model offers it.
          models.onChange(value === DEFAULT ? undefined : value, models.effort && next?.efforts.includes(models.effort as never) ? models.effort : undefined, !!models.fast && !!next?.fast)
        }}
      >
        {latest.map((c) => (
          <ModelItem key={c.model} choice={c} choices={choices} />
        ))}
        {older.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ProviderIcon provider="claude" />
              <span className="flex-1">Older models</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              {older.map((c) => (
                <ModelItem key={c.model} choice={c} choices={choices} />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuRadioGroup>
    )
  }
  return (
    <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('claude')}>
      <DropdownMenuRadioItem value="claude" closeOnClick disabled={provider !== 'claude' && !setProvider}>
        <ProviderIcon provider="claude" />
        {provider === 'claude' ? label : AGENT_NAMES.claude}
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  )
}

/**
 * OpenCode's group: every `provider/model` its configured providers offered the running session, by provider, or OpenCode as a
 * single choice (a new session starts on OpenCode's default model; the list arrives once its sandbox is up).
 */
function OpenCodeModels({
  models,
  provider,
  setProvider,
  enabled,
  label,
}: {
  models?: ModelPicker
  provider: AgentProvider
  setProvider?: (provider: AgentProvider) => void
  enabled?: boolean
  label: string
}) {
  const choices = provider === 'opencode' ? (models?.choices ?? []) : []
  if (models && choices.length > 0) {
    const groups = new Map<string, AgentModelChoice[]>()
    for (const c of choices) {
      const group = c.model.slice(0, c.model.indexOf('/'))
      groups.set(group, [...(groups.get(group) ?? []), c])
    }
    return (
      <DropdownMenuRadioGroup value={models.model ?? DEFAULT} onValueChange={(value) => models.onChange(value === DEFAULT ? undefined : value, undefined, false)}>
        <DropdownMenuRadioItem value={DEFAULT} closeOnClick>
          <ProviderIcon provider="opencode" />
          Default
        </DropdownMenuRadioItem>
        {[...groups].map(([group, items]) => (
          <DropdownMenuSub key={group}>
            <DropdownMenuSubTrigger>
              <ProviderIcon provider="opencode" />
              <span className="flex-1 truncate">{group}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              {items.map((c) => (
                <DropdownMenuRadioItem key={c.model} value={c.model} closeOnClick title={c.model}>
                  <span className="min-w-0 truncate">{c.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuRadioGroup>
    )
  }
  return (
    <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('opencode')}>
      <DropdownMenuRadioItem value="opencode" closeOnClick disabled={provider !== 'opencode' && (!setProvider || !enabled)}>
        <ProviderIcon provider="opencode" />
        {provider === 'opencode' ? label : AGENT_NAMES.opencode}
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  )
}

/**
 * Antigravity's group: the models `agy models` listed for the running session, by family ("Gemini 4 Neon", its efforts inside), or
 * Antigravity as a single choice (a new session starts on agy's default model; the list arrives once its sandbox is up).
 */
function AntigravityModels({
  models,
  provider,
  setProvider,
  enabled,
  label,
}: {
  models?: ModelPicker
  provider: AgentProvider
  setProvider?: (provider: AgentProvider) => void
  enabled?: boolean
  label: string
}) {
  const choices = provider === 'antigravity' ? (models?.choices ?? []) : []
  if (models && choices.length > 0) {
    const groups = new Map<string, AgentModelChoice[]>()
    for (const c of choices) {
      const family = c.name.replace(/\s*\([^)]*\)\s*$/, '') || c.model
      groups.set(family, [...(groups.get(family) ?? []), c])
    }
    return (
      <DropdownMenuRadioGroup value={models.model ?? DEFAULT} onValueChange={(value) => models.onChange(value === DEFAULT ? undefined : value, undefined, false)}>
        <DropdownMenuRadioItem value={DEFAULT} closeOnClick>
          <ProviderIcon provider="antigravity" />
          Default
        </DropdownMenuRadioItem>
        {[...groups].map(([family, items]) =>
          items.length === 1 ? (
            <DropdownMenuRadioItem key={family} value={items[0]!.model} closeOnClick title={items[0]!.model}>
              <ProviderIcon provider="antigravity" />
              <span className="min-w-0 truncate">{items[0]!.name}</span>
            </DropdownMenuRadioItem>
          ) : (
            <DropdownMenuSub key={family}>
              <DropdownMenuSubTrigger>
                <ProviderIcon provider="antigravity" />
                <span className="flex-1 truncate">{family}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                {items.map((c) => (
                  <DropdownMenuRadioItem key={c.model} value={c.model} closeOnClick title={c.model}>
                    <span className="min-w-0 truncate">{c.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ),
        )}
      </DropdownMenuRadioGroup>
    )
  }
  return (
    <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('antigravity')}>
      <DropdownMenuRadioItem value="antigravity" closeOnClick disabled={provider !== 'antigravity' && (!setProvider || !enabled)}>
        <ProviderIcon provider="antigravity" />
        {provider === 'antigravity' ? label : AGENT_NAMES.antigravity}
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  )
}

/** One Claude model. The default names the model it stands for in grey ("Default  Opus 5.5"), so it never truncates. */
function ModelItem({ choice: c, choices }: { choice: AgentModelChoice; choices: AgentModelChoice[] }) {
  const stands = c.model === DEFAULT ? modelName(choices, c.model) : undefined
  return (
    <DropdownMenuRadioItem value={c.model} closeOnClick title={c.description}>
      <ProviderIcon provider="claude" />
      <span className="min-w-0 truncate">{c.model === DEFAULT ? 'Default' : modelLabel(c)}</span>
      {stands && stands !== c.name && <span className="min-w-0 truncate text-muted-foreground">{stands}</span>}
    </DropdownMenuRadioItem>
  )
}

/** A submenu row: its name, then the current value in grey before the chevron. */
function SubRow({ icon, name, value }: { icon: ReactNode; name: string; value: string }) {
  return (
    <>
      {icon}
      <span className="flex-1">{name}</span>
      <span className="text-muted-foreground">{value}</span>
    </>
  )
}

/** The chosen model's efforts (the agent's default first) and fast mode, each in its own submenu so the menu stays short. */
function ModelOptions({ models, efforts, fastOffered, fast }: { models: ModelPicker; efforts: string[]; fastOffered: boolean; fast: boolean }) {
  if (!efforts.length && !fastOffered) return null
  const effort = models.effort
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {efforts.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SubRow icon={<EffortBars level={effort ? barsFor(efforts, effort) : 0} />} name="Effort" value={effort ? effortName(effort) : 'Default'} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuRadioGroup value={effort ?? DEFAULT} onValueChange={(value) => models.onChange(models.model, value === DEFAULT ? undefined : value, fast)}>
                <DropdownMenuRadioItem value={DEFAULT} closeOnClick>
                  <EffortBars level={0} />
                  Default
                </DropdownMenuRadioItem>
                {efforts.map((e) => (
                  <DropdownMenuRadioItem key={e} value={e} closeOnClick>
                    <EffortBars level={barsFor(efforts, e)} />
                    {effortName(e)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {fastOffered && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SubRow icon={<ZapIcon />} name="Fast mode" value={fast ? 'On' : 'Off'} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-32">
              <DropdownMenuRadioGroup value={fast ? 'on' : 'off'} onValueChange={(value) => models.onChange(models.model, models.effort, value === 'on')}>
                <DropdownMenuRadioItem value="on" closeOnClick>
                  On
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="off" closeOnClick>
                  Off
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuGroup>
    </>
  )
}

/** What the agent itself reported, so the trigger is never only what was asked for. */
function ModelConfirmation({ active }: { active?: { model?: string; effort?: string } }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel className="font-normal text-muted-foreground" data-testid="model-confirmation">
          {active ? (
            <span>
              Running <span className="font-mono">{active.model}</span>
              {active.effort ? ` at ${effortName(active.effort).toLowerCase()} effort` : ''}.
            </span>
          ) : (
            'Applies from your next message.'
          )}
        </DropdownMenuLabel>
      </DropdownMenuGroup>
    </>
  )
}

/** One menu for the agent, Claude's model and the effort. */
function ModelMenu({
  provider,
  setProvider,
  codexEnabled,
  openCodeEnabled,
  antigravityEnabled,
  picker,
  agentLabel,
  isNewSession,
  disabled,
}: {
  provider: AgentProvider
  setProvider?: (provider: AgentProvider) => void
  codexEnabled?: boolean
  openCodeEnabled?: boolean
  antigravityEnabled?: boolean
  picker?: ModelPicker
  agentLabel?: string
  isNewSession: boolean
  disabled: boolean
}) {
  const { models, choices, active, label, effort, efforts, fastOffered, fast } = modelMenuState(provider, picker, agentLabel)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            aria-label={`Model: ${label}${effort ? `, effort: ${effortName(effort)}` : ''}${fast ? ', fast mode' : ''}`}
            className="ml-auto h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <span data-testid="model-label">{label}</span>
        {effort && efforts.length > 0 && (
          <span className="text-muted-foreground">
            <EffortBars level={barsFor(efforts, effort)} />
          </span>
        )}
        {fast && <ZapIcon className="text-muted-foreground" />}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{AGENT_NAMES.claude}</DropdownMenuLabel>
          <ClaudeModels models={models} choices={choices} provider={provider} setProvider={setProvider} label={label} />
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{AGENT_NAMES.codex}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={provider} onValueChange={() => setProvider?.('codex')}>
            <DropdownMenuRadioItem value="codex" closeOnClick disabled={provider !== 'codex' && (!setProvider || !codexEnabled)}>
              <ProviderIcon provider="codex" />
              {provider === 'codex' ? label : AGENT_NAMES.codex}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{AGENT_NAMES.opencode}</DropdownMenuLabel>
          <OpenCodeModels models={models} provider={provider} setProvider={setProvider} enabled={openCodeEnabled !== false} label={label} />
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{AGENT_NAMES.antigravity}</DropdownMenuLabel>
          <AntigravityModels models={models} provider={provider} setProvider={setProvider} enabled={antigravityEnabled !== false} label={label} />
        </DropdownMenuGroup>
        {models && <ModelOptions models={models} efforts={efforts} fastOffered={fastOffered} fast={fast} />}
        {models && !isNewSession && <ModelConfirmation active={active} />}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui): the box holds the text, attachments and main button; the compact bar below holds the repository
 * and one menu for the model (by agent) and the effort. The main button sends, or stops the agent while it is working. With `setRepo` it is the "new session" form (the first
 * message also names the repository). Claude's models and efforts are the ones the agent reported; images are attached with the + button, by pasting or by dropping them
 * anywhere in the window (from Finder too: the desktop shell leaves file drops to the page).
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
  placeholder,
  showRepo,
  provider = 'claude',
  setProvider,
  codexEnabled,
  openCodeEnabled,
  antigravityEnabled,
  onStop,
  onQueue,
  queued,
  status,
  picker,
  agentLabel,
  upload,
  reply,
  onClearReply,
  machine,
  focusKey,
  draftKey,
  usage,
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
  /** The box's hint (default: asks for a code change). */
  placeholder?: string
  /** False for a session with no repository of its own to show (a dork). */
  showRepo?: boolean
  provider?: AgentProvider
  /** Without it the agent is fixed (a running session): the menu shows it but only the effort can change. */
  setProvider?: (provider: AgentProvider) => void
  /** Codex only shows up as a choice when a Boat ChatGPT environment is configured. Claude Code is the default. */
  codexEnabled?: boolean
  /** OpenCode needs no sign-in of its own: its provider keys (`OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`...) are shared secrets. */
  openCodeEnabled?: boolean
  /** Antigravity signs in with the shared secret `ANTIGRAVITY_OAUTH_TOKEN` (or `GEMINI_API_KEY`); a missing one shows up in the thread. */
  antigravityEnabled?: boolean
  /** Set while the agent is working: the main button becomes Stop (or Steer now, with something to send). */
  onStop?: () => void
  /** ⌘ Enter (Ctrl Enter): queue the message for when the agent's turn ends, like `onSubmit` otherwise. Without it ⌘ Enter sends. */
  onQueue?: (images: AttachedImage[]) => void | Promise<unknown>
  /** The queued messages, shown as rows in a frame joined to the top of the box. */
  queued?: ReactNode
  /** A line above the box, e.g. the sandbox status. */
  status?: ReactNode
  /** Claude's model and effort. */
  picker?: ModelPicker
  /** What to call the agent's model when there is no picker (Codex). */
  agentLabel?: string
  /** Uploads an attached image, resolving with its server id. Without it nothing can be attached. */
  upload?: (file: File) => Promise<string>
  /** What the next message replies to: a banner above the text, with an X (or Escape) to drop it. */
  reply?: Reply
  onClearReply?: () => void
  /** The build a new session starts on (docs/builds.md); shown once there is a built one. */
  machine?: MachinePicker
  /** Puts the cursor in the box on mount and whenever this changes (a new visit to the page), once it is enabled. Not on touch screens, where it would pop the keyboard. */
  focusKey?: string
  /** Keeps the attached images under this key (the text draft's) while the owner visits other chats. */
  draftKey?: string
  /** The usage ring after the model menu (`<UsageMenu />`). */
  usage?: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const { files, attachError, attach, remove, clearSent, ready, uploading } = useAttachments(upload, draftKey)
  // A new reply puts the cursor in the box, ready to answer it.
  useEffect(() => {
    if (reply) textRef.current?.focus()
  }, [reply])
  // The text stays beside attach and the main button as it wraps, its last line level with them, with or without attached images
  // above it.
  const isNewSession = setRepo !== undefined
  const locked = !!(pending || disabled)
  const dragging = useFileDrop(attach, !!upload && !locked, formRef)
  useEffect(() => {
    if (focusKey === undefined || locked || !matchMedia('(hover: hover)').matches) return
    textRef.current?.focus()
  }, [focusKey, locked])
  const hasContent = text.trim().length > 0 || ready.length > 0
  const canSend = hasContent && !uploading && !locked && (!isNewSession || !!repo?.trim())
  const submit = async (handler = onSubmit) => {
    const sent = files
    try {
      if ((await handler(ready.map((f) => ({ id: f.imageId!, name: f.name })))) === false) return
    } catch {
      return
    }
    clearSent(sent)
  }
  const shownError = error || attachError
  return (
    // The prompt input is published with an 18px group and pill buttons; the app's 6px radius is lifted for it alone.
    <div className="mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-4 px-5 pb-3 [--control-radius:18px]">
      {status}
      <form
        ref={formRef}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSend) void submit()
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
        <QueueFrame queued={queued}>
          <InputGroup
            data-dragging={dragging}
            className="in-data-queue:-mx-px in-data-queue:-mb-px in-data-queue:w-auto data-[dragging=true]:border-ring data-[dragging=true]:ring-[3px] data-[dragging=true]:ring-ring/50 rounded-[15px] border-border bg-white has-[textarea]:rounded-[15px] has-[>[data-align=block-start]]:rounded-[15px] dark:border-transparent dark:bg-input/50"
          >
            {reply && (
              // The reply banner sits 8px inside the box (the buttons' inset), concentric with its 15px corners.
              <InputGroupAddon align="block-start" className="px-2 pt-2 pb-0">
                <ReplyBanner
                  reply={reply}
                  onClear={() => {
                    onClearReply?.()
                    textRef.current?.focus()
                  }}
                />
              </InputGroupAddon>
            )}
            {files.length > 0 ? (
              // Attached images as plain thumbnails, the text's left edge, no file names: a 112px tile with the image filling it, a hairline
              // drawn inside its edge so a white screenshot keeps its shape, and a remove button in its corner on hover or focus.
              <InputGroupAddon align="block-start" className="flex-wrap justify-start gap-2 px-[42px] pt-3 pb-0">
                <ImageLightbox images={files.map((f) => ({ id: f.key, src: f.preview, alt: f.name }))} label="Attached images">
                  {files.map((file, index) => (
                    <AttachmentTile key={file.key} file={file} index={index} onRemove={() => remove(file.key)} />
                  ))}
                </ImageLightbox>
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
              placeholder={hintOf(placeholder)}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
                if (!upload || !images.length) return
                e.preventDefault()
                attach(images)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && reply && onClearReply) {
                  e.preventDefault()
                  onClearReply()
                  return
                }
                onEnter(
                  e,
                  () => formRef.current?.requestSubmit(),
                  onQueue,
                  () => canSend && void submit(onQueue),
                )
              }}
              disabled={locked}
              ref={textRef}
              rows={1}
              // A 44px row: 12px above and below a 20px line of 15px text, 42px in from each side (past the 28px buttons, 8px from the
              // edge, and 6px more).
              className="max-h-[40vh] min-h-0 py-3 px-[42px] leading-5 md:text-[15px]"
            />
            {/* Attach and the main button keep one spot, 8px from the bottom corners, level with the text's last line. */}
            <div className="absolute bottom-2 left-2">
              <Tip label="Attach images">
                <InputGroupButton
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-foreground [--control-radius:6px]"
                  aria-label="Attach images"
                  disabled={!upload || locked}
                  onClick={() => fileRef.current?.click()}
                >
                  <PlusIcon className="size-4" />
                </InputGroupButton>
              </Tip>
            </div>
            <div className="absolute right-2 bottom-2">
              <MainButton onStop={onStop} isNewSession={isNewSession} pending={pending} canSend={canSend} canQueue={!!onQueue} />
            </div>
          </InputGroup>
        </QueueFrame>
        {/* Compact, shared baseline for the repository and model controls. 9px in (8px plus the box's 1px border), like attach and send, so the repository
            button lines up under attach and the model button under send. */}
        <div className="flex items-center gap-2 px-[9px] pt-2 text-[13px] [--control-radius:6px]">
          <RepositoryControl repo={repo} setRepo={setRepo} repositories={repositories} disabled={locked} hidden={showRepo === false} />
          {machine && machine.builds.length > 0 && <MachineMenu machine={machine} disabled={locked} />}
          <ModelMenu
            provider={provider}
            setProvider={setProvider}
            codexEnabled={codexEnabled}
            openCodeEnabled={openCodeEnabled}
            antigravityEnabled={antigravityEnabled}
            picker={picker}
            agentLabel={agentLabel}
            isNewSession={isNewSession}
            disabled={locked}
          />
          {usage}
        </div>
      </form>
      {shownError && (
        <p className="px-3 text-sm text-destructive" role="alert">
          {shownError}
        </p>
      )}
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
      <DropdownMenuTrigger
        disabled={disabled}
        render={<InputGroupButton size="sm" variant="ghost" aria-label={`Machine: ${name}`} className="h-7 min-w-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" />}
      >
        <BoxIcon className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate" data-testid="machine-label">
          {name}
        </span>
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
            <DropdownMenuRadioItem value={BASE} closeOnClick>
              Base machine
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const REPO = /^[\w.-]+\/[\w.-]+$/

/** One repository row: the owner's avatar, then `owner/name` with the owner muted. */
export function RepoRow({ repo }: { repo: string }) {
  const owner = ownerOf(repo)
  return (
    <>
      <OwnerAvatar owner={owner} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{owner}/</span>
        {repo.slice(owner.length + 1)}
      </span>
    </>
  )
}

export const REPO_ITEM = 'h-8 gap-2 rounded-[6px] px-2 py-0 font-normal data-selected:bg-foreground/[0.05] [&>svg:last-child]:size-3.5'

/**
 * The repository for a new session: a searchable list of the GitHub CLI login's repositories (and the ones chats used), the chosen one
 * first. Typing a full `owner/repo` that is not listed offers it too, since a first session may name any repository.
 */
function RepositoryPicker({ repo, setRepo, repositories, disabled }: { repo: string; setRepo: (repo: string) => void; repositories: string[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const choose = (value: string) => {
    setRepo(value.trim())
    setOpen(false)
  }
  const q = query.trim().toLowerCase()
  const others = repositories.filter((r) => r !== repo && (!q || r.toLowerCase().includes(q)))
  const showSelected = !!repo && (!q || repo.toLowerCase().includes(q))
  const typed = query.trim()
  const canUseTyped = REPO.test(typed) && !repositories.some((r) => r.toLowerCase() === typed.toLowerCase()) && typed.toLowerCase() !== repo.toLowerCase()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            className="h-7 min-w-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
            aria-label={`Repository: ${repo || 'Choose repository'}`}
            title={repo}
          />
        }
      >
        {repo ? <OwnerAvatar owner={ownerOf(repo)} size={16} className="size-3.5" /> : <FolderIcon />}
        <span className="max-w-48 truncate">{repo || 'Choose repository'}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      {/* Styled as the app's dropdown menus (hairline, soft shadow, 32px rows), since that is what it is. */}
      <PopoverContent align="start" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 ring-0`}>
        <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
          <CommandMenuInput aria-label="Search repositories" autoFocus value={query} onValueChange={setQuery} placeholder="Search repositories…" />
          <CommandList className="max-h-72 p-1">
            <CommandEmpty className="px-2 py-3 text-left text-xs text-muted-foreground">
              {typed ? 'No repositories match. Type a full owner/repo to use it.' : 'No repositories yet. Type an owner/repo.'}
            </CommandEmpty>
            {canUseTyped && (
              <CommandItem value={`use:${typed}`} onSelect={() => choose(typed)} className={REPO_ITEM}>
                <PlusIcon className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Use {typed}</span>
              </CommandItem>
            )}
            {showSelected && (
              <CommandItem value={repo} data-checked="true" onSelect={() => choose(repo)} className={REPO_ITEM}>
                <RepoRow repo={repo} />
              </CommandItem>
            )}
            {showSelected && others.length > 0 && <CommandSeparator className="-mx-1 my-1 bg-border" />}
            {others.map((value) => (
              <CommandItem key={value} value={value} onSelect={() => choose(value)} className={REPO_ITEM}>
                <RepoRow repo={value} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
