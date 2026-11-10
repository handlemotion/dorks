import { ArrowUpIcon, ChevronDownIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@dorks/ui/dropdown-menu'
import { Input } from '@dorks/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '@dorks/ui/input-group'

export type AgentProvider = 'codex' | 'claude'

/**
 * The message box: a glass input group with the agent picker and send/stop buttons. With `repo` it is the "new session" form
 * (the first message also names the repository).
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
  provider,
  setProvider,
  codexEnabled,
  onStop,
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
  setProvider?: (provider: AgentProvider) => void
  /** Codex only shows up as a choice when a Boat ChatGPT environment is configured. Claude Code is the default. */
  codexEnabled?: boolean
  onStop?: () => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const canSend = text.trim().length > 0 && !pending && !disabled && (repo === undefined || repo.trim().length > 0)
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5">
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); if (canSend) onSubmit() }}>
        <InputGroup className="glass-strong rounded-3xl">
          {repo !== undefined && setRepo ? (
            <InputGroupAddon align="block-start">
              <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                Repository
                <Input aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={pending || disabled} placeholder="owner/repo" className="h-8 w-44 max-w-full" />
              </label>
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            aria-label={repo !== undefined ? 'first message' : 'message'}
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
            className="min-h-14 p-3"
          />
          <InputGroupAddon align="block-end">
            {provider && setProvider && codexEnabled ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={pending}
                  render={<InputGroupButton size="sm" variant="outline" aria-label={`Agent: ${provider === 'codex' ? 'Codex' : 'Claude Code'}`} />}
                >
                  {provider === 'codex' ? 'Codex' : 'Claude Code'}
                  <ChevronDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Agent</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={provider} onValueChange={(value) => {
                      if (value === 'codex' || value === 'claude') setProvider(value)
                    }}>
                      <DropdownMenuRadioItem value="claude">Claude Code</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : provider ? (
              <InputGroupText>{provider === 'codex' ? 'Codex' : 'Claude Code'}</InputGroupText>
            ) : null}
            {onStop && <InputGroupButton variant="outline" size="icon-sm" className="ml-auto" aria-label="Stop agent" title="Stop agent" onClick={onStop}><SquareIcon /></InputGroupButton>}
            <InputGroupButton type="submit" size="icon-sm" variant="default" className={onStop ? undefined : 'ml-auto'} aria-label={repo !== undefined ? 'Create session' : 'Send message'} title={repo !== undefined ? 'Create session' : 'Send message'} disabled={!canSend}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}
