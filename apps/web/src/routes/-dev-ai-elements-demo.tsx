import { TooltipProvider } from '@dorks/ui/tooltip'
import { ChainOfThoughtDemo } from '@dorks/ui/ai-elements/chain-of-thought'
import { ChatDemo } from '@dorks/ui/ai-elements/chat'
import { CheckpointDemo } from '@dorks/ui/ai-elements/checkpoint'
import { ConfirmationDemo } from '@dorks/ui/ai-elements/confirmation'
import { ContextDemo } from '@dorks/ui/ai-elements/context'
import { FileTreeDemo } from '@dorks/ui/ai-elements/file-tree'
import { InlineCitationDemo } from '@dorks/ui/ai-elements/inline-citation'
import { MessagePattern } from '@dorks/ui/ai-elements/message'
import { ModelSelectorDemo } from '@dorks/ui/ai-elements/model-selector'
import { PlanDemo } from '@dorks/ui/ai-elements/plan'
import { PromptInputDemo } from '@dorks/ui/ai-elements/prompt-input'
import { QueueDemo } from '@dorks/ui/ai-elements/queue'
import { ReasoningDemo } from '@dorks/ui/ai-elements/reasoning'
import { SourcesDemo } from '@dorks/ui/ai-elements/sources'
import { StackTraceDemo } from '@dorks/ui/ai-elements/stack-trace'
import { SubagentDemo } from '@dorks/ui/ai-elements/subagent'
import { SuggestionDemo } from '@dorks/ui/ai-elements/suggestion'
import { TaskDemo } from '@dorks/ui/ai-elements/task'
import { TerminalDemo } from '@dorks/ui/ai-elements/terminal'
import { TestResultsDemo } from '@dorks/ui/ai-elements/test-results'
import { ToolDemo } from '@dorks/ui/ai-elements/tool'

// Each pattern is the published shadcn AI Elements demo, unmodified (see packages/ui/README.md).
const patterns = [
  { id: 'chain-of-thought', title: 'Chain Of Thought', Pattern: ChainOfThoughtDemo },
  { id: 'chat', title: 'Chat', Pattern: ChatDemo },
  { id: 'checkpoint', title: 'Checkpoint', Pattern: CheckpointDemo },
  { id: 'confirmation', title: 'Confirmation', Pattern: ConfirmationDemo },
  { id: 'context', title: 'Context', Pattern: ContextDemo },
  { id: 'file-tree', title: 'File Tree', Pattern: FileTreeDemo },
  { id: 'inline-citation', title: 'Inline Citation', Pattern: InlineCitationDemo },
  { id: 'message', title: 'Message', Pattern: MessagePattern },
  { id: 'model-selector', title: 'Model Selector', Pattern: ModelSelectorDemo },
  { id: 'plan', title: 'Plan', Pattern: PlanDemo },
  { id: 'prompt-input', title: 'Prompt Input', Pattern: PromptInputDemo },
  { id: 'queue', title: 'Queue', Pattern: QueueDemo },
  { id: 'reasoning', title: 'Reasoning', Pattern: ReasoningDemo },
  { id: 'sources', title: 'Sources', Pattern: SourcesDemo },
  { id: 'stack-trace', title: 'Stack Trace', Pattern: StackTraceDemo },
  { id: 'subagent', title: 'Subagent', Pattern: SubagentDemo },
  { id: 'suggestion', title: 'Suggestion', Pattern: SuggestionDemo },
  { id: 'task', title: 'Task', Pattern: TaskDemo },
  { id: 'terminal', title: 'Terminal', Pattern: TerminalDemo },
  { id: 'test-results', title: 'Test Results', Pattern: TestResultsDemo },
  { id: 'tool', title: 'Tool', Pattern: ToolDemo },
]

export function Demo() {
  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <nav className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3 text-sm" aria-label="Patterns">
          {patterns.map((p) => (
            <a key={p.id} href={`#${p.id}`} className="rounded-md px-2 py-1 hover:bg-accent">
              {p.title}
            </a>
          ))}
        </nav>
        <main className="flex-1 overflow-y-auto scroll-smooth">
          {patterns.map((p) => (
            <section key={p.id} id={p.id} data-testid={`pattern-${p.id}`} className="border-b p-8">
              <h2 className="mb-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">{p.title}</h2>
              <p.Pattern />
            </section>
          ))}
        </main>
      </div>
    </TooltipProvider>
  )
}
