import { ArrowUpIcon, ChevronDownIcon, FileTextIcon, LoaderCircleIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
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
const MAIN = 'rounded-full bg-brand text-brand-foreground hover:bg-brand-hover'
const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui): the box holds the text and one round main button; under it sit the chat's settings, attach on the left
 * and one menu for the model (by agent) and the effort on the right. The main button sends, or stops the agent while it is working. With `repo` it is the "new session" form (the first
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
  const canSend = text.trim().length > 0 && !pending && !disabled && (repo === undefined || repo.trim().length > 0)
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
        <InputGroup className="border-border bg-white dark:border-transparent dark:bg-input/50">
          {(repo !== undefined && setRepo) || files.length > 0 ? (
            <InputGroupAddon align="block-start" className="flex-wrap">
              {repo !== undefined && setRepo && (
                <Input aria-label="repo" name="repo" autoComplete="off" data-1p-ignore data-lpignore="true" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={pending || disabled} placeholder="owner/repo" className="h-8 w-44 max-w-full" />
              )}
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
            aria-label={repo !== undefined ? 'first message' : 'message'}
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
            className="min-h-[76px] py-3 pr-12 pl-4"
          />
          {/* Inside the box: only the main button, pinned bottom right so the text runs beside it. */}
          <InputGroupAddon align="block-end" className="absolute right-0 bottom-0 w-auto p-[9px]">
            {onStop ? (
              <InputGroupButton size="icon-sm" variant="default" className={MAIN} aria-label="Stop agent" title="Stop agent" onClick={onStop}>
                <SquareIcon className="fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-sm" variant="default" className={MAIN} aria-label={repo !== undefined ? 'Create session' : 'Send message'} title={repo !== undefined ? 'Create session' : 'Send message'} disabled={!canSend}>
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {/* Under the box: the chat's settings, attach on the left and the model and effort on the right. */}
        <div className="flex items-center gap-2 px-[9px] pt-1.5">
          <InputGroupButton size="icon-sm" variant="ghost" className="rounded-full text-muted-foreground hover:text-foreground" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
            <PlusIcon />
          </InputGroupButton>
          <DropdownMenu>
            <DropdownMenuTrigger disabled={pending} render={<InputGroupButton size="sm" variant="ghost" aria-label={`Model: ${model.name}, effort: ${currentEffort.name}`} className="ml-auto h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" />}>
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
