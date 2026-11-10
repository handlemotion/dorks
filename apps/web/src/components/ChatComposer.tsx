import { ArrowUpIcon, ChevronDownIcon, FileTextIcon, FolderIcon, LoaderCircleIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentMedia, AttachmentTitle } from '@dorks/ui/attachment'
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

export type AgentProvider = 'codex' | 'claude'

/** The models offered per agent, newest first; the first is the agent's default. */
const MODELS: { id: string; provider: AgentProvider; name: string }[] = [
  { id: 'claude-opus-5-5', provider: 'claude', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', provider: 'claude', name: 'Sonnet 5.5' },
  { id: 'gpt-5.5-codex', provider: 'codex', name: 'GPT-5.5 Codex' },
]
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
const MAIN = 'rounded-full bg-brand text-brand-foreground hover:bg-brand-hover disabled:bg-foreground/[0.08] disabled:text-foreground/35 disabled:opacity-100'
const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui): the box holds the text, attachments and main button; the compact bar below holds the repository
 * and one menu for the model (by agent) and the effort. The main button sends, or stops the agent while it is working. With `setRepo` it is the "new session" form (the first
 * message also names the repository). Not wired to the server yet: attached files, the model and the effort are kept here only.
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
}: {
  text: string
  setText: (text: string) => void
  onSubmit: () => void
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
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<{ id: string; name: string }[]>([])
  const [effort, setEffort] = useState('medium')
  const [modelId, setModelId] = useState<string>()
  const isNewSession = setRepo !== undefined
  const canSend = text.trim().length > 0 && !pending && !disabled && (!isNewSession || !!repo?.trim())
  const model = MODELS.find((m) => m.id === modelId && m.provider === provider) ?? MODELS.find((m) => m.provider === provider) ?? MODELS[0]
  const effortLevel = Math.max(0, EFFORTS.findIndex((e) => e.id === effort))
  const currentEffort = EFFORTS[effortLevel]
  return (
    // The prompt input is published with an 18px group and pill buttons; the app's 6px radius is lifted for it alone.
    <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 px-5 pb-3 [--control-radius:18px]">
      {status}
      <form ref={formRef} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canSend) onSubmit() }}>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const selected = e.target.files
            if (selected) setFiles((current) => [...current, ...Array.from(selected, (f) => ({ id: crypto.randomUUID(), name: f.name }))])
            e.target.value = ''
          }}
        />
        {/* White on the off-white app (light), with the panel's 6% hairline since that pair is under 1.15:1; dark keeps the published fill. */}
        <InputGroup className="rounded-[15px] border-border bg-white has-[textarea]:rounded-[15px] has-[>[data-align=block-end]]:rounded-[15px] dark:border-transparent dark:bg-input/50">
          {files.length > 0 ? (
            <InputGroupAddon align="block-start" className="flex-wrap">
              {files.map((file) => (
                <Attachment key={file.id} size="sm">
                  <AttachmentMedia>
                    <FileTextIcon />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}>
                      <XIcon />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
            disabled={pending || disabled}
            // 15px in from the side, as far in as the corner's radius, and 14px from the top.
            className="min-h-24 px-[15px] pt-3.5 pb-12"
          />
          {/* Prompt actions stay inside the box; project and model settings sit below. */}
          <InputGroupAddon align="block-end" className="absolute inset-x-0 bottom-0 justify-between p-[9px]">
            <InputGroupButton size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-foreground [--control-radius:6px]" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
              <PlusIcon className="size-[18px]" />
            </InputGroupButton>
            {onStop ? (
              <InputGroupButton size="icon-sm" variant="default" className={MAIN} aria-label="Stop agent" title="Stop agent" onClick={onStop}>
                <SquareIcon className="fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-sm" variant="default" className={MAIN} aria-label={isNewSession ? 'Create session' : 'Send message'} title={isNewSession ? 'Create session' : 'Send message'} disabled={!canSend}>
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {/* Compact, shared baseline for the repository and model controls. */}
        <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] [--control-radius:6px]">
          {repo !== undefined && (setRepo ? (
            <RepositoryPicker repo={repo} setRepo={setRepo} repositories={repositories} disabled={pending || disabled} />
          ) : (
            <span title={repo} data-testid="chat-repository" className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="max-w-48 truncate">{repo}</span>
            </span>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger disabled={pending} render={<InputGroupButton size="sm" variant="ghost" aria-label={`Model: ${model.name}, effort: ${currentEffort.name}`} className="ml-auto h-7 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground" />}>
              {model.name}
              <span className="text-muted-foreground"><EffortBars level={effortLevel + 1} /></span>
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {(['claude', 'codex'] as const).map((p) => (
                <DropdownMenuGroup key={p}>
                  <DropdownMenuLabel>{AGENT_NAMES[p]}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={model.id} onValueChange={(id) => { setModelId(id); if (p !== provider) setProvider?.(p) }}>
                    {MODELS.filter((m) => m.provider === p).map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={m.id} closeOnClick disabled={p !== provider && (!setProvider || (p === 'codex' && !codexEnabled))}>
                        <ProviderIcon provider={p} />
                        {m.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Effort</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
                  {EFFORTS.map((e, i) => (
                    <DropdownMenuRadioItem key={e.id} value={e.id} closeOnClick>
                      <EffortBars level={i + 1} />
                      {e.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </form>
      {error && <p className="px-3 text-sm text-destructive" role="alert">{error}</p>}
    </div>
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
