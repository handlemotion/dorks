import { ArrowUpIcon, ChevronDownIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
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
import claudeLogo from '../assets/providers/claude.svg'
import openaiDark from '../assets/providers/openai-dark.svg'
import openaiLight from '../assets/providers/openai-light.svg'
import { Logo } from './onboarding/List'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@dorks/ui/input-group'

export type AgentProvider = 'codex' | 'claude'

const AGENT_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  // svgl pads the OpenAI mark inside its viewBox, so it is scaled to sit at Claude's size.
  return provider === 'claude' ? <Logo light={claudeLogo} className="size-3.5" /> : <Logo light={openaiLight} dark={openaiDark} className="size-3.5 scale-[1.3]" />
}

/** The primary chat action. */
const MAIN = 'rounded-full bg-brand text-brand-foreground hover:bg-brand-hover'

/** Text chat and provider selection; model recovery uses the choices reported by the bridge. */
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
  /** Without it the agent is fixed for the running session. */
  setProvider?: (provider: AgentProvider) => void
  /** Codex only shows up as a choice when a Boat ChatGPT environment is configured. Claude Code is the default. */
  codexEnabled?: boolean
  /** Set while the agent is working: the main button becomes Stop. */
  onStop?: () => void
  /** A line above the box, e.g. the sandbox status. */
  status?: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const canSend = text.trim().length > 0 && !pending && !disabled && (repo === undefined || repo.trim().length > 0)
  return (
    // The prompt input is published with an 18px group and pill buttons; the app's 6px radius is lifted for it alone.
    <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 px-5 pb-3 [--control-radius:18px]">
      {status}
      <form ref={formRef} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canSend) onSubmit() }}>
        {/* White on the off-white app (light), with the panel's 6% hairline since that pair is under 1.15:1; dark keeps the published fill. */}
        <InputGroup className="rounded-[15px] border-border bg-white has-[textarea]:rounded-[15px] has-[>[data-align=block-end]]:rounded-[15px] dark:border-transparent dark:bg-input/50">
          {repo !== undefined && setRepo ? (
            <InputGroupAddon align="block-start" className="flex-wrap">
              {repo !== undefined && setRepo && (
                <Input aria-label="repo" name="repo" autoComplete="off" data-1p-ignore data-lpignore="true" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={pending || disabled} placeholder="owner/repo" className="h-8 w-44 max-w-full" />
              )}
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
            // 15px in from the side, as far in as the corner's radius, and 14px from the top.
            className="min-h-24 pt-3.5 pr-12 pb-3 pl-[15px]"
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
        <div className="flex items-center justify-end gap-2 pt-1.5 [--control-radius:6px]">
          {setProvider ? (
            <DropdownMenu>
              <DropdownMenuTrigger disabled={pending} render={<InputGroupButton size="sm" variant="ghost" aria-label={`Agent: ${AGENT_NAMES[provider]}`} className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" />}>
                <ProviderIcon provider={provider} />
                {AGENT_NAMES[provider]}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Agent</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={provider} onValueChange={(value) => setProvider(value as AgentProvider)}>
                    {(['claude', 'codex'] as const).map((p) => (
                      <DropdownMenuRadioItem key={p} value={p} closeOnClick disabled={p === 'codex' && !codexEnabled}>
                        <ProviderIcon provider={p} />
                        {AGENT_NAMES[p]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="flex h-8 items-center gap-1.5 px-2.5 text-xs text-muted-foreground"><ProviderIcon provider={provider} />{AGENT_NAMES[provider]}</span>
          )}
        </div>
      </form>
      {error && <p className="px-3 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}
