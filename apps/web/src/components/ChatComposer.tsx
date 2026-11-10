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
  onStop?: () => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const canSend = text.trim().length > 0 && !pending && !disabled && (repo === undefined || repo.trim().length > 0)
  return (
    <div className="dorks-composer-wrap">
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); if (canSend) onSubmit() }}>
        <InputGroup>
          {repo !== undefined && setRepo ? (
            <InputGroupAddon align="block-start">
              <label className="dorks-repo">Repository <Input aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={pending || disabled} placeholder="owner/repo" /></label>
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
            className="p-3"
          />
          <InputGroupAddon align="block-end">
            {provider && setProvider ? (
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
                      <DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="claude">Claude Code</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : provider ? (
              <InputGroupText>{provider === 'codex' ? 'Codex' : 'Claude Code'}</InputGroupText>
            ) : null}
            {onStop && <InputGroupButton variant="outline" size="icon-sm" className="ml-auto rounded-full" aria-label="Stop agent" title="Stop agent" onClick={onStop}><SquareIcon /></InputGroupButton>}
            <InputGroupButton type="submit" size="icon-sm" variant="default" className={onStop ? 'rounded-full' : 'ml-auto rounded-full'} aria-label={repo !== undefined ? 'Create session' : 'Send message'} title={repo !== undefined ? 'Create session' : 'Send message'} disabled={!canSend}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      {error && <p className="dorks-error" role="alert">{error}</p>}
    </div>
  )
}
