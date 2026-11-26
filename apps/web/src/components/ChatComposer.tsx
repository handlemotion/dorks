import { BoxIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, LaptopIcon, LoaderCircleIcon, PlusIcon, SquareIcon, XIcon, ZapIcon } from 'lucide-react'
import { modelLabel, type AgentModelChoice } from '@dorks/shared'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject, type ReactNode } from 'react'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandMenuInput, CommandList } from '@dorks/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@dorks/ui/popover'
import { Switch } from '@dorks/ui/switch'
import claudeLogo from '@dorks/onboarding/assets/providers/claude.svg'
import antigravityLogo from '@dorks/onboarding/assets/providers/antigravity.svg'
import codexDark from '@dorks/onboarding/assets/providers/codex_dark.svg'
import codexLight from '@dorks/onboarding/assets/providers/codex_light.svg'
import openaiDark from '@dorks/onboarding/assets/providers/openai-dark.svg'
import openaiLight from '@dorks/onboarding/assets/providers/openai-light.svg'
import opencodeDark from '@dorks/onboarding/assets/providers/opencode-dark.svg'
import opencodeLight from '@dorks/onboarding/assets/providers/opencode.svg'
import { Logo } from './onboarding/List'
import { OwnerAvatar, ownerOf, REPO_ITEM } from './RepoAvatar'
import { EnvironmentPicker, type EnvironmentChoice } from './EnvironmentPicker'
import { HERE, LocationMenu, type LocationChoice } from './LocationMenu'
import { MODE_HINTS, type ModeChoice } from './ModeMenu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@dorks/ui/input-group'
import { Tip } from './Tip'
import { ImageLightbox, ImageTrigger } from './ImageLightbox'
import { ReplyBanner, SEND_KEY } from './Reply'
import { useComposerMenu, type Mentions } from './ComposerMenu'
import { addDropZone, dropZoneFor } from '../lib/fileDrop'
import type { Reply } from '../lib/reply'
import { rememberEffort, startingEffort } from '../lib/effort'

export type AgentProvider = 'codex' | 'claude' | 'opencode' | 'antigravity'

const AGENT_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

export function ProviderIcon({ provider }: { provider: AgentProvider }) {
  // Each agent's own mark (svgl): Claude, Codex, OpenCode and Antigravity.
  if (provider === 'opencode') return <Logo light={opencodeLight} dark={opencodeDark} className="size-3.5 rounded-[2px]" />
  if (provider === 'antigravity') return <Logo light={antigravityLogo} className="size-3.5" />
  if (provider === 'codex') return <Logo light={codexLight} dark={codexDark} className="size-3.5" />
  return <Logo light={claudeLogo} className="size-3.5" />
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
/** Codex's model when a new session names none: the short list's first GPT (Codex lists its models only once a session runs). */
export const CODEX_PREFERRED = 'gpt-6.2-sol'
/** The effort a Claude model starts at (`startingEffort`), from the efforts and resolved id the agent reported for it. */
export const claudeStartingEffort = (choices: readonly AgentModelChoice[], model: string | undefined) => {
  const c = choices.find((x) => x.model === (model ?? DEFAULT))
  return startingEffort('claude', model ?? DEFAULT, c?.efforts ?? [], c?.resolved)
}
/**
 * An effort as one to three bars, by its name, so medium and high never draw alike (five levels spread over three bars did): low and
 * below one, medium two, high and above three. The menu names the exact level.
 */
const BARS: Record<string, number> = { none: 1, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 3, max: 3 }
const barsFor = (_efforts: string[], effort: string) => BARS[effort] ?? 2

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
  useEffect(
    () =>
      draftKey === undefined
        ? () =>
            setFiles((current) => {
              current.forEach((f) => URL.revokeObjectURL(f.preview))
              return []
            })
        : undefined,
    [key],
  )
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
    const unregister = addDropZone({ form: () => formRef.current, enabled: () => !!attachRef.current })
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
    <div data-queue className="flex flex-col rounded-[11px] border border-border bg-muted dark:bg-card">
      {queued}
      {children}
    </div>
  )
}

/** The send arrow: lucide's ArrowUp is drawn short and sits high at 14px; this one is 16px with the shaft spanning the box, centered on its middle. */
function SendArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="size-4!">
      <path d="M8 13.25V2.75M3.5 7.25 8 2.75l4.5 4.5" />
    </svg>
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
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <SendArrow />}
      </InputGroupButton>
    </Tip>
  )
}

/** Whether the session needs a repository, and the box's hint: the caller's, else what the mode's agent is asked for. */
const modeOf = (mode: ModeChoice | undefined, placeholder?: string) => ({
  needsRepo: !mode || mode.value === 'code',
  hint: placeholder ?? MODE_HINTS[mode?.value ?? 'code'],
})

/** Where the session runs: the environment chooser for a new session, else its build (or, without one known, its repository). */
function RepositoryControl({
  repo,
  build,
  environment,
  disabled,
  hidden,
  needsRepo,
  local,
}: {
  repo?: string
  build?: string | null
  environment?: EnvironmentChoice
  disabled: boolean
  hidden?: boolean
  needsRepo: boolean
  local?: boolean
}) {
  if (hidden) return null
  // A local session works on this computer, in a worktree of its repository (docs/local-dorks.md): no build, no sandbox.
  if (local && !environment) {
    return (
      <span title={repo ? `On ${HERE}, in a worktree of ${repo}` : `On ${HERE}`} data-testid="chat-local" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
        <LaptopIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate">{repo || 'Local'}</span>
      </span>
    )
  }
  // A chat or a nerd works in no repository: no chooser for a new one.
  if (environment) return needsRepo ? <EnvironmentPicker choice={environment} disabled={disabled} /> : null
  if (build !== undefined) {
    const name = build ?? 'Base machine'
    return (
      <span title={repo ? `${name}, ${repo}` : name} data-testid="chat-build" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
        <BoxIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate">{name}</span>
      </span>
    )
  }
  if (!needsRepo && !repo) return null
  if (repo === undefined) return null
  return (
    <span title={repo} data-testid="chat-repository" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
      {repo ? <OwnerAvatar owner={ownerOf(repo)} size={16} className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
      <span className="max-w-48 truncate">{repo || 'No repository'}</span>
    </span>
  )
}

const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort

/** Something to send: text, an image, or a reply with a note (the note is what the owner wrote). */
const hasMessage = (text: string, images: number, reply?: Reply) => text.trim().length > 0 || images > 0 || !!reply?.note?.trim()

/** The model menu is locked while sending; a box locked because the chosen agent is not connected keeps it, so another is a click away. */
const menuLocked = (pending: boolean, disabled: boolean | undefined, canSwitch: boolean) => pending || (!!disabled && !canSwitch)

/** What the model menu shows: the model picker (Claude, Codex, OpenCode and Antigravity), the trigger's label, and the efforts the chosen model has. */
function modelMenuState(provider: AgentProvider, picker: ModelPicker | undefined, agentLabel: string | undefined) {
  const models = picker
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

/** A model in the menu: an agent and one of its models (none: the agent's own default). The effort it starts at is `startingEffort`'s. */
type ModelEntry = { key: string; provider: AgentProvider; model?: string; name: string; detail?: string }

/**
 * The menu's short list, in this order: the owner's pick across the agents. Everything else (older Claude models, every Antigravity and
 * OpenCode model the agent reported, the ChatGPT plan's Codex models, each agent's default) is one search away. Two Codex models are
 * named here for a first session, before any Codex session has listed the plan's; one the plan cannot use pauses the session and asks
 * for another.
 */
const CURATED: ModelEntry[] = [
  { key: 'claude:opus', provider: 'claude', model: 'opus', name: 'Claude Opus 5.5' },
  { key: 'codex:gpt-6.2-sol', provider: 'codex', model: 'gpt-6.2-sol', name: 'GPT Sol 6.2' },
  { key: 'claude:fable', provider: 'claude', model: 'fable', name: 'Fable 5.2' },
  // Antigravity's effort is part of the slug: these name the family, and `curated` fills in the effort it starts at.
  { key: 'antigravity:gemini-4-carbon', provider: 'antigravity', model: 'gemini-4-carbon', name: 'Gemini Carbon' },
  { key: 'antigravity:gemini-4-neon', provider: 'antigravity', model: 'gemini-4-neon', name: 'Gemini Neon' },
  { key: 'claude:sonnet', provider: 'claude', model: 'sonnet', name: 'Sonnet 5.5' },
  { key: 'codex:gpt-6.2-astra', provider: 'codex', model: 'gpt-6.2-astra', name: 'GPT Astra 6.2' },
]

/**
 * Switches to a model from the menu. Every model starts at its own effort (the owner's last pick for it, or the recommended one),
 * never the previous model's; fast mode stays on only where the new model offers it.
 */
function pickModel(
  e: ModelEntry,
  ctx: {
    provider: AgentProvider
    setProvider?: (provider: AgentProvider, choice?: { model?: string; effort?: string }) => void
    models?: ModelPicker
    choices: AgentModelChoice[]
    catalog: Partial<Record<AgentProvider, AgentModelChoice[]>>
    searched: boolean
  },
) {
  const { provider, models, choices } = ctx
  // A Gemini slug found by search and picked by its effort (`gemini-4-neon-high`) is that family's effort from now on.
  const gemini = ctx.searched && e.provider === 'antigravity' ? GEMINI_EFFORT.exec(e.model ?? '') : null
  if (gemini) rememberEffort('antigravity', gemini[1], gemini[2]!)
  const effort = effortFor(e, { ...ctx.catalog, [provider]: choices })
  if (e.provider !== provider) return ctx.setProvider?.(e.provider, e.model ? { model: e.model, effort } : {})
  if (!models) return
  if (provider !== 'claude') return models.onChange(e.model, effort, false)
  const next = choices.find((c) => c.model === (e.model ?? DEFAULT))
  models.onChange(e.model, effort, !!models.fast && !!next?.fast)
}

/** An Antigravity family's efforts: the ones its slugs in the list carry, or all of them before agy has listed any. */
function geminiEfforts(family: string, known: readonly AgentModelChoice[]): string[] {
  const listed = GEMINI_LEVELS.filter((e) => known.some((c) => c.model === `${family}-${e}`))
  return listed.length ? listed : ['low', 'medium', 'high']
}

/** The Antigravity models known: the list agy gave, and a running Antigravity session's own. */
const geminiKnown = (provider: AgentProvider, choices: AgentModelChoice[], catalog?: Partial<Record<AgentProvider, AgentModelChoice[]>>) => [
  ...(catalog?.antigravity ?? []),
  ...(provider === 'antigravity' ? choices : []),
]

/** The short list with each Antigravity family on the slug for the effort it starts at, named in grey beside it. */
function curated(known: readonly AgentModelChoice[]): ModelEntry[] {
  return CURATED.map((e) => {
    if (e.provider !== 'antigravity' || !e.model) return e
    const effort = startingEffort('antigravity', e.model, geminiEfforts(e.model, known)) ?? 'medium'
    return { ...e, key: `antigravity:${e.model}-${effort}`, model: `${e.model}-${effort}`, detail: effortName(effort) }
  })
}

/** The effort a model picked from the menu starts at, so the trigger and what is sent agree from the first message. */
function effortFor(e: ModelEntry, catalog: Partial<Record<AgentProvider, AgentModelChoice[]>>): string | undefined {
  if (e.provider === 'claude') return claudeStartingEffort(catalog.claude ?? [], e.model)
  if (e.provider === 'codex') return e.model ? startingEffort('codex', e.model, CODEX_EFFORTS) : undefined
  return undefined
}

/** Antigravity's names carry their effort in brackets ("Gemini 4 Neon (High)"): the name, and the effort in grey. */
function splitDetail(name: string): { name: string; detail?: string } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name)
  return m ? { name: m[1]!, detail: m[2] } : { name }
}

/** What the search finds beyond the short list: the models each agent reported (the session's own, and the lists known ahead), and each agent's own default. */
function searchableModels(catalog: Partial<Record<AgentProvider, AgentModelChoice[]>>, short: ModelEntry[]): ModelEntry[] {
  const reported = (Object.entries(catalog) as [AgentProvider, AgentModelChoice[] | undefined][]).flatMap(([provider, choices]) =>
    (choices ?? [])
      .filter((c) => c.model !== DEFAULT)
      .map((c): ModelEntry => ({ key: `${provider}:${c.model}`, provider, model: c.model, ...(provider === 'claude' ? { name: modelLabel(c) } : splitDetail(c.name || c.model)) })),
  )
  const defaults = (Object.keys(AGENT_NAMES) as AgentProvider[]).map((p): ModelEntry => ({ key: `${p}:`, provider: p, name: AGENT_NAMES[p], detail: 'Default model' }))
  const seen = new Set(short.map((e) => e.key))
  return [...short, ...reported.filter((e) => !seen.has(e.key)), ...defaults]
}

/** What the agent itself reported, so the trigger is never only what was asked for. */
function ModelConfirmation({ active }: { active?: { model?: string; effort?: string } }) {
  return (
    <p className="px-3 pt-1 pb-2.5 text-xs text-muted-foreground" data-testid="model-confirmation">
      {active ? (
        <>
          Running <span className="font-mono">{active.model}</span>
          {active.effort ? ` at ${effortName(active.effort).toLowerCase()} effort` : ''}.
        </>
      ) : (
        'Applies from your next message.'
      )}
    </p>
  )
}

/** The list's title: "Models" over the short list; search results go untitled. */
const modelsHeading = (query: string) => (query ? undefined : 'Models')

/** A group's small title, as the build chooser's ("Builds", "Base machine"): groups are told apart by these, not by dividers. */
const MENU_HEADING = 'px-2 py-1.5 text-xs font-medium text-muted-foreground'

/**
 * The chosen model's effort and fast mode, the first two rows above the models. Fast mode is Claude's: shown for every Claude model,
 * switched off and greyed where the model does not offer it.
 */
function ModelSettings({ models, effort, fastShown, fastOffered, fast }: { models: ModelPicker; effort?: EffortChoice; fastShown: boolean; fastOffered: boolean; fast: boolean }) {
  if (!effort && !fastShown) return null
  return (
    <div className="flex flex-col p-1">
      <p className={MENU_HEADING}>Options</p>
      {effort && <EffortChooser choice={effort} />}
      {fastShown && (
        <label className={`flex h-8 items-center gap-2 px-2 text-sm ${fastOffered ? 'cursor-pointer' : 'text-muted-foreground'}`} title={fastOffered ? undefined : 'This model has no fast mode'}>
          <ZapIcon className="size-3.5 fill-current text-muted-foreground" />
          <span className="flex-1">Fast mode</span>
          <Switch size="sm" checked={fast} disabled={!fastOffered} onCheckedChange={(on) => models.onChange(models.model, models.effort, on)} aria-label="Fast mode" />
        </label>
      )}
    </div>
  )
}

/** A model's mark: GPT models show ChatGPT's (they run on Codex, but the model is what the menu names), the rest their agent's. */
function ModelMark({ entry }: { entry: Pick<ModelEntry, 'provider' | 'model'> }) {
  // ChatGPT's mark fills about two thirds of its square: scaled up to look the size of the others (as onboarding does).
  if (entry.provider === 'codex' && entry.model) return <Logo light={openaiLight} dark={openaiDark} className="size-3.5 scale-[1.3]" />
  return <ProviderIcon provider={entry.provider} />
}

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']
const GEMINI_LEVELS = ['low', 'medium', 'high', 'xhigh']
const GEMINI_EFFORT = /^(.*)-(low|medium|high|xhigh)$/

/**
 * The chosen model's efforts and how to change it. Every model has one: Claude's are the ones the model reports, Codex's are its four,
 * and an Antigravity model's effort is part of its slug (`gemini-4-neon-high`), so changing it picks the family's other slug.
 */
function effortChoice(
  provider: AgentProvider,
  models: ModelPicker | undefined,
  choices: AgentModelChoice[],
  catalog: Partial<Record<AgentProvider, AgentModelChoice[]>>,
  active?: { effort?: string },
) {
  if (!models) return undefined
  if (provider === 'antigravity') {
    const m = GEMINI_EFFORT.exec(models.model ?? '')
    if (!m) return undefined
    const family = m[1]!
    const effort = m[2]!
    const efforts = [...new Set([...geminiEfforts(family, [...(catalog.antigravity ?? []), ...choices]), effort])].sort((a, b) => GEMINI_LEVELS.indexOf(a) - GEMINI_LEVELS.indexOf(b))
    return {
      efforts,
      effort,
      set: (e: string) => {
        rememberEffort('antigravity', family, e)
        models.onChange(`${family}-${e}`, undefined, false)
      },
    }
  }
  if (provider === 'codex') {
    // The efforts the plan lists for the model once Codex has reported them; a session on Codex's own default runs it at high.
    const listed = choices.find((c) => c.model === models.model)?.efforts
    const efforts: string[] = listed?.length ? [...listed] : CODEX_EFFORTS
    const effort = models.effort ?? (models.model ? startingEffort('codex', models.model, efforts) : 'high')
    return {
      efforts,
      effort,
      set: (e: string) => {
        if (models.model) rememberEffort('codex', models.model, e)
        models.onChange(models.model, e, false)
      },
    }
  }
  const efforts: string[] = [...(choices.find((c) => c.model === (models.model ?? DEFAULT))?.efforts ?? [])]
  if (!efforts.length) return undefined
  return {
    efforts,
    effort: models.effort ?? active?.effort,
    set: (e: string) => {
      rememberEffort('claude', models.model ?? DEFAULT, e)
      models.onChange(models.model, e, !!models.fast)
    },
  }
}
type EffortChoice = NonNullable<ReturnType<typeof effortChoice>>

/**
 * The effort menu lies 2px over the model menu's edge. It is placed from the Effort row, which sits 5px inside that edge (the menu's
 * 1px hairline and 4px padding), so it is offset 3px from the row.
 */
/** Effort as a row naming the current one, with its choices in a menu nested to the side: the first option above the models. */
function EffortChooser({ choice }: { choice: EffortChoice }) {
  const [open, setOpen] = useState(false)
  const { efforts, effort, set } = choice
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={80}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-sm outline-none hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] data-[popup-open]:bg-foreground/[0.05]"
      >
        <span className="text-muted-foreground">
          <EffortBars level={effort ? barsFor(efforts, effort) : 0} />
        </span>
        <span className="flex-1 text-left">Effort</span>
        <span className="text-muted-foreground">{effort ? effortName(effort) : 'Default'}</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={3} alignOffset={-4} className={`${MENU_POPUP_CLASS} w-40 gap-0 p-1 ring-0`}>
        <div role="radiogroup" aria-label="Effort" className="flex flex-col">
          {efforts.map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={e === effort}
              onClick={() => {
                set(e)
                setOpen(false)
              }}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-sm outline-none hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]"
            >
              <span className="text-muted-foreground">
                <EffortBars level={barsFor(efforts, e)} />
              </span>
              <span className="flex-1">{effortName(e)}</span>
              {e === effort && <CheckIcon className="size-3.5" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * One searchable menu for the agent and its model, styled like the build chooser: a search over every model, then (without a query)
 * effort and fast mode for the chosen model, then the short list (`CURATED`). Picking another agent's model switches the agent; a
 * running session keeps its agent, so those are greyed out.
 */
function ModelMenu({
  provider,
  setProvider,
  codexEnabled,
  openCodeEnabled,
  antigravityEnabled,
  picker,
  agentLabel,
  isNewSession,
  catalog,
  disabled,
}: {
  provider: AgentProvider
  setProvider?: (provider: AgentProvider, choice?: { model?: string; effort?: string }) => void
  codexEnabled?: boolean
  openCodeEnabled?: boolean
  antigravityEnabled?: boolean
  picker?: ModelPicker
  agentLabel?: string
  isNewSession: boolean
  catalog?: Partial<Record<AgentProvider, AgentModelChoice[]>>
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { models, choices, active, label, fastOffered, fast } = modelMenuState(provider, picker, agentLabel)
  const enabled: Record<AgentProvider, boolean> = { claude: true, codex: !!codexEnabled, opencode: openCodeEnabled !== false, antigravity: antigravityEnabled !== false }
  const current = models?.model ?? (models ? undefined : null)
  // A session on the agent's default is checked on the model the agent runs (`opus` resolves to the `claude-opus-…` it reported).
  const runs = active?.model ?? choices.find((c) => c.model === DEFAULT)?.resolved
  const resolves = (e: ModelEntry) => !!runs && !current && choices.find((c) => c.model === e.model)?.resolved === runs
  const isCurrent = (e: ModelEntry) => e.provider === provider && ((e.model ?? undefined) === (current ?? undefined) || resolves(e))
  // Another agent only on a new session; a running Codex session changes its model from the thread.
  const canPick = (e: ModelEntry) => isCurrent(e) || (e.provider === provider ? !!models : !!setProvider && enabled[e.provider])
  const effortNow = effortChoice(provider, models, choices, catalog ?? {}, active)
  const short = curated(geminiKnown(provider, choices, catalog))
  const selected = short.find(isCurrent)
  const shownLabel = selected ? selected.name : label
  const q = query.trim().toLowerCase()
  const entries = q
    ? searchableModels({ ...catalog, [provider]: choices }, short).filter((e) => `${AGENT_NAMES[e.provider]} ${e.name} ${e.detail ?? ''} ${e.model ?? ''}`.toLowerCase().includes(q))
    : short
  const pick = (e: ModelEntry) => {
    setOpen(false)
    pickModel(e, { provider, setProvider, models, choices, catalog: catalog ?? {}, searched: !!q })
  }
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
            aria-label={`Model: ${shownLabel}${effortNow?.effort ? `, effort: ${effortName(effortNow.effort)}` : ''}${fast ? ', fast mode' : ''}`}
            className="ml-auto h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <span data-testid="model-label">{shownLabel}</span>
        {effortNow?.effort && (
          <span className="text-muted-foreground">
            <EffortBars level={barsFor(effortNow.efforts, effortNow.effort)} />
          </span>
        )}
        {fast && <ZapIcon className="fill-current text-muted-foreground" />}
        <ChevronDownIcon />
      </PopoverTrigger>
      {/* Styled as the app's dropdown menus (hairline, soft shadow, 32px rows), like the build chooser. */}
      <PopoverContent align="end" className={`${MENU_POPUP_CLASS} w-80 gap-0 p-0 ring-0`}>
        <Command shouldFilter={false} loop className="rounded-none bg-transparent p-0">
          <CommandMenuInput aria-label="Search all models" autoFocus value={query} onValueChange={setQuery} placeholder="Search all models…" />
          {!q && models && <ModelSettings models={models} effort={effortNow} fastShown={provider === 'claude'} fastOffered={fastOffered} fast={fast} />}
          <CommandList className="max-h-80">
            <CommandEmpty className="px-3 py-3 text-left text-xs text-muted-foreground">No models match.</CommandEmpty>
            <CommandGroup heading={modelsHeading(q)} className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5">
              {entries.map((e) => (
                <CommandItem key={e.key} value={e.key} disabled={!canPick(e)} data-checked={isCurrent(e) ? 'true' : undefined} onSelect={() => pick(e)} className={REPO_ITEM} title={e.model}>
                  <ModelMark entry={e} />
                  <span className="min-w-0 flex-1 truncate">
                    {e.name}
                    {e.detail && <span className="ms-1.5 text-muted-foreground">{e.detail}</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {models && !isNewSession && <ModelConfirmation active={active} />}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui): the box holds the text, attachments and main button; the compact bar below holds the repository
 * and one menu for the model (by agent) and the effort. The main button sends, or stops the agent while it is working. With `environment` it is the "new session" form (the first
 * message also picks the build or repository). Claude's models and efforts are the ones the agent reported; images are attached with the + button, by pasting or by dropping them
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
  build,
  environment,
  location,
  local,
  mode,
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
  catalog,
  agentLabel,
  upload,
  reply,
  onClearReply,
  focusKey,
  draftKey,
  typeToFocus,
  usage,
  mentions,
}: {
  text: string
  setText: (text: string) => void
  /** Resolves once sent; the attachments are cleared then, and kept if it throws or resolves `false`. */
  onSubmit: (images: AttachedImage[]) => void | Promise<unknown>
  pending: boolean
  disabled?: boolean
  error: string
  repo?: string
  /** An existing session's build, shown in the bar: its name, or null on the base machine. Undefined: unknown, the repository shows. */
  build?: string | null
  /** The new session form's one chooser: a build (with its repositories) or a repository on the base machine. */
  environment?: EnvironmentChoice
  /** The new session form's Cloud / Local choice (docs/local-dorks.md), when this client may start local sessions. */
  location?: LocationChoice
  /** An existing session that runs on this computer: the bar says so instead of naming a build. */
  local?: boolean
  /** The session's mode (docs/modes.md), set by the workspace: only code asks for a repository. */
  mode?: ModeChoice
  /** The box's hint (default: the mode's, else asks for a code change). */
  placeholder?: string
  /** False for a session with no repository of its own to show (a dork). */
  showRepo?: boolean
  provider?: AgentProvider
  /** Without it the agent is fixed (a running session): the menu shows it but only the effort can change. */
  /** Models known before a session runs, by agent (the owner's Claude and Antigravity lists): the model menu's search finds them. */
  catalog?: Partial<Record<AgentProvider, AgentModelChoice[]>>
  /** Switches the agent, optionally straight to one of its models (a model of another agent picked from the menu). */
  setProvider?: (provider: AgentProvider, choice?: { model?: string; effort?: string }) => void
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
  /** Puts the cursor in the box on mount and whenever this changes (a new visit to the page), once it is enabled. Not on touch screens, where it would pop the keyboard. */
  focusKey?: string
  /** Keeps the attached images under this key (the text draft's) while the owner visits other chats. */
  draftKey?: string
  /** The page's main composer: typing a character while nothing takes text (focus on the page, a button, the transcript) puts the cursor here, with the character. */
  typeToFocus?: boolean
  /** The usage ring after the model menu (`<UsageMenu />`). */
  usage?: ReactNode
  /** What `/` (skills and commands) and `@` (the repository's files) offer in a menu above the box. */
  mentions?: Mentions
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const { files, attachError, attach, remove, clearSent, ready, uploading } = useAttachments(upload, draftKey)
  const menu = useComposerMenu({ text, setText, textRef, mentions })
  // A new reply puts the cursor in the box, ready to answer it.
  useEffect(() => {
    if (reply) textRef.current?.focus()
  }, [reply])
  // The text stays beside attach and the main button as it wraps, its last line level with them, with or without attached images
  // above it.
  const isNewSession = environment !== undefined
  const locked = !!(pending || disabled)
  const dragging = useFileDrop(attach, !!upload && !locked, formRef)
  useEffect(() => {
    if (focusKey === undefined || disabled || !matchMedia('(hover: hover)').matches) return
    textRef.current?.focus()
  }, [focusKey, disabled])
  useTypeToFocus(textRef, !!typeToFocus && !disabled)
  const hasContent = hasMessage(text, ready.length, reply)
  const { needsRepo, hint } = modeOf(mode, placeholder)
  const canSend = hasContent && !uploading && !locked && (!environment || !needsRepo || !!environment.value.repo.trim())
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
        className="relative"
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
        {menu.menu}
        {/* White on the off-white app (light), with the panel's 6% hairline since that pair is under 1.15:1; dark keeps the published fill. */}
        <QueueFrame queued={queued}>
          <InputGroup
            data-dragging={dragging}
            className="in-data-queue:-mx-px in-data-queue:-mb-px in-data-queue:w-auto data-[dragging=true]:border-ring data-[dragging=true]:ring-[3px] data-[dragging=true]:ring-ring/50 rounded-[10px] border-border bg-white has-[textarea]:rounded-[10px] has-[>[data-align=block-start]]:rounded-[10px] dark:border-transparent dark:bg-input/50"
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
              placeholder={hint}
              value={text}
              {...menu.inputProps}
              onChange={(e) => {
                setText(e.target.value)
                menu.track()
              }}
              onSelect={menu.track}
              onBlur={menu.blur}
              onPaste={(e) => {
                const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
                if (!upload || !images.length) return
                e.preventDefault()
                attach(images)
              }}
              onKeyDown={(e) => {
                if (menu.onKeyDown(e)) return
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
              // Read-only, not disabled, while a message is sending: a disabled field drops the cursor, and the owner would have to click back in.
              disabled={disabled}
              readOnly={pending}
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
          <RepositoryControl repo={repo} build={build} environment={environment} disabled={locked} hidden={showRepo === false} needsRepo={needsRepo} local={local} />
          {location && <LocationMenu choice={location} disabled={locked} />}
          <ModelMenu
            provider={provider}
            setProvider={setProvider}
            codexEnabled={codexEnabled}
            openCodeEnabled={openCodeEnabled}
            antigravityEnabled={antigravityEnabled}
            picker={picker}
            agentLabel={agentLabel}
            isNewSession={isNewSession}
            catalog={catalog}
            disabled={menuLocked(pending, disabled, !!setProvider)}
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

/** Where typing goes already: a field, an editable element, or a dialog or menu (their own keys, type-ahead included). */
function takesKeys(el: Element | null) {
  if (!el || el === document.body) return false
  if (el.closest('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox]')) return true
  return (
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLIFrameElement || (el instanceof HTMLElement && el.isContentEditable)
  )
}

/** A printable key pressed with nothing taking text moves the cursor to the end of the box; the key's own input then lands there. */
function useTypeToFocus(textRef: RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return
      const el = textRef.current
      const active = document.activeElement
      if (!el || el === active || takesKeys(active)) return
      // Space presses a focused button or link; only from the page itself does it start a message.
      if (e.key === ' ' && active && active !== document.body) return
      // An open modal (a dialog, a sheet) owns the keyboard even when its focus has left it.
      if (document.querySelector('[role=dialog][aria-modal=true], [role=alertdialog]')) return
      const end = el.value.length
      el.focus()
      el.setSelectionRange(end, end)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, textRef])
}
