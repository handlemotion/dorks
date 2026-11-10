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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@dorks/ui/input-group'

export type AgentProvider = 'codex' | 'claude'

const AGENTS: { id: AgentProvider; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
]
const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

/**
 * The message box: the AI Elements prompt input, copied from the published component (ui.shadcn.com/docs/ai-elements/base/prompt-input,
 * `PromptInputDemo` in @dorks/ui) and the Figma reference: attach, then one menu for the agent and the effort on the right, then
 * one round main button. The main button sends, or stops the agent while it is working. With `repo` it is the "new session" form (the first
 * message also names the repository). Not wired to the server yet: attached files and the effort are kept here only.
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
  const canSend = text.trim().length > 0 && !pending && !disabled && (repo === undefined || repo.trim().length > 0)
  const agent = AGENTS.find((a) => a.id === provider) ?? AGENTS[0]
  const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[1]
  return (
    // The prompt input is published with an 18px group and pill buttons; the app's 6px radius is lifted for it alone.
    <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 px-3 pb-3 [--control-radius:18px]">
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
        <InputGroup>
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
            className="min-h-16 p-3"
          />
          <InputGroupAddon align="block-end" className="gap-2 px-2.5 pt-1.5 pb-2">
            <InputGroupButton size="icon-sm" variant="outline" className="rounded-full" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
              <PlusIcon />
            </InputGroupButton>
            <DropdownMenu>
              <DropdownMenuTrigger disabled={pending} render={<InputGroupButton size="sm" variant="outline" aria-label={`Agent: ${agent.name}, effort: ${currentEffort.name}`} className="ml-auto" />}>
                {agent.name}
                <span className="text-muted-foreground">{currentEffort.name}</span>
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Agent</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={provider} onValueChange={(value) => setProvider?.(value as AgentProvider)}>
                    {AGENTS.map((a) => (
                      <DropdownMenuRadioItem key={a.id} value={a.id} closeOnClick disabled={!setProvider || (a.id === 'codex' && !codexEnabled)}>
                        {a.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Effort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
                    {EFFORTS.map((e) => (
                      <DropdownMenuRadioItem key={e.id} value={e.id} closeOnClick>
                        {e.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {onStop ? (
              <InputGroupButton size="icon-sm" variant="default" className="rounded-full" aria-label="Stop agent" title="Stop agent" onClick={onStop}>
                <SquareIcon className="fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-sm" variant="default" className="rounded-full" aria-label={repo !== undefined ? 'Create session' : 'Send message'} title={repo !== undefined ? 'Create session' : 'Send message'} disabled={!canSend}>
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
      {error && <p className="px-3 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}
