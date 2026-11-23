import { useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentModelChoice } from '@dorks/shared'
import { useConnection, useDork, useDorkEvents, useDorksClient, useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@dorks/ui/message-scroller'
import { AgentStatus } from './AgentStatus'
import { ChatMessages } from './ChatBlock'
import { Composer, withImages, type ModelPicker } from './ChatComposer'
import { LocalAccessProvider } from './LocalRequest'
import { useDraft } from '../lib/draft'
import { usePending } from '../lib/pending'
import { withReply, type Reply } from '../lib/reply'
import { currentStep, stepLabel } from '../lib/progress'

export type DorkView = NonNullable<ReturnType<typeof useDork>>

const AGENT_NAMES: Record<DorkView['provider'], string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

/** The model menu for a running session: Claude's models, the ones OpenCode's providers offer, or Antigravity's; Codex has none. */
export function claudePicker(dork: DorkView, fallback: AgentModelChoice[] | undefined, onChange: ModelPicker['onChange']): ModelPicker | undefined {
  if (dork.provider === 'codex') return undefined
  return {
    choices: dork.modelChoices ?? (dork.provider === 'claude' ? fallback : undefined) ?? [],
    model: dork.model,
    effort: dork.effort,
    fast: dork.fast,
    active: { model: dork.agentModel, effort: dork.agentEffort },
    onChange,
  }
}

/** The error that put the Dork in error is said once, in red on the status line, not as its own row above it. */
function splitProblem<B extends { kind: string }>(all: B[], state: string | undefined): { blocks: B[]; problem?: string } {
  const last = all.at(-1) as (B & { level?: string; text?: string }) | undefined
  if (state !== 'error' || last?.kind !== 'notice' || last.level !== 'error') return { blocks: all }
  return { blocks: all.slice(0, -1), problem: last.text }
}

/**
 * A session's conversation: its transcript (the thread, light as everywhere: bubbles, then each turn's messages with its tool calls between them) and
 * the composer under it, with Stop, replies and the model menu. The page's chat and a dork's worker panel (CrewDetails) both use it;
 * `compact` is the panel's narrower column.
 */
export function SessionChat({
  dork,
  compact,
  error: extraError,
  draft,
  onOpenSteps,
}: {
  dork: DorkView
  /**
   * The composer's text when the page also writes into it (Chat details' "Ask for…" actions, a picked element): one draft, owned by the
   * page. Without it the chat keeps its own (a worker in a dork's panel).
   */
  draft?: [string, Dispatch<SetStateAction<string>>]
  compact?: boolean
  /** Another action's failure to show over the composer (archive, the page's own controls). */
  error?: string
  /**
   * Opens Progress on these steps (none: just Progress). The thread's tool lines and the status line call it; without it (a worker in
   * a dork's panel, a narrow window) they are plain text.
   */
  onOpenSteps?: (keys: string[]) => void
}) {
  const dorkId = dork.id
  const { actions } = useDorksClient()
  const { view, canLoadMore, loadMore, error: eventsError, send } = useDorkEvents(dorkId)
  const own = useDraft(dorkId)
  const [text, setText] = draft ?? own
  const [reply, setReply] = useState<Reply>()
  const { run, pending, error } = usePending()
  const stop = usePending()
  const modelSwitch = usePending()
  const settings = useSettings()
  const { live } = useConnection()
  const agent = AGENT_NAMES[dork.provider]
  const canReply = !dork.archived
  const current = dork.state === 'working' ? currentStep(view.blocks) : {}
  const needsAttention = Boolean(dork.needsAttention) || view.blocks.some((b) => (b.kind === 'local' && b.status === 'pending') || (b.kind === 'build' && b.approved === null))
  const { blocks, problem } = splitProblem(view.blocks, dork.state)
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          {/* No fade at the bottom edge: the published viewport masks it with scroll-fade-b; the last line stays fully drawn above the composer. */}
          <MessageScrollerViewport aria-label="Session transcript" className="mask-none! [scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
            <MessageScrollerContent className={`mx-auto w-full max-w-4xl gap-6 pt-6 pb-12 ${compact ? 'px-6' : 'px-10'}`} data-testid="transcript">
              {canLoadMore && (
                <div className="text-center">
                  <Button variant="outline" size="sm" onClick={loadMore}>
                    Load older
                  </Button>
                </div>
              )}
              <LocalAccessProvider dorkId={dorkId} agent={agent}>
                <ChatMessages
                  blocks={blocks}
                  imageUrl={actions.imageUrl}
                  agent={agent}
                  onOpenSteps={onOpenSteps}
                  onReply={
                    canReply
                      ? (quoted, draft) => {
                          setReply(quoted)
                          if (draft) setText((t) => (t.trim() ? `${t}\n\n${draft}` : draft))
                        }
                      : undefined
                  }
                  onReplySend={canReply ? (quoted, answer) => run(() => send(withReply(quoted, answer))) : undefined}
                />
              </LocalAccessProvider>
              {eventsError && (
                <p role="alert" className="text-sm text-destructive">
                  Could not load messages: {eventsError.message}. Retrying…
                </p>
              )}
              <div>
                <AgentStatus
                  state={dork.state}
                  live={live}
                  outcome={view.lastOutcome}
                  attention={needsAttention}
                  step={current.tool && stepLabel(current.tool)}
                  since={current.since}
                  problem={problem}
                  onOpen={onOpenSteps && view.blocks.some((b) => b.kind === 'tool') ? () => onOpenSteps(current.tool ? [current.tool.id] : []) : undefined}
                />
              </div>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer
        text={text}
        setText={setText}
        repo={dork.repo}
        {...(dork.kind === 'coordinator' ? { placeholder: 'Tell the dork what to do next...', showRepo: false } : {})}
        provider={dork.provider ?? 'claude'}
        pending={pending}
        disabled={dork.archived}
        error={[error, stop.error, extraError, modelSwitch.error].find(Boolean) ?? ''}
        agentLabel={dork.codexModel?.model}
        picker={claudePicker(dork, settings?.claudeModels, (model, effort, fast) => void modelSwitch.run(() => actions.chooseModel(dorkId, model ?? null, effort ?? null, fast)))}
        upload={actions.uploadImage}
        reply={reply}
        onClearReply={() => setReply(undefined)}
        onSubmit={(images) =>
          run(async () => {
            const sent = text
            const quoted = reply
            // The optimistic row shows it at once; put the text and the reply back if the server refuses.
            setText('')
            setReply(undefined)
            try {
              await send(withReply(quoted, withImages(sent, images)))
            } catch (e) {
              setText(sent)
              setReply(quoted)
              throw e
            }
          })
        }
        onStop={dork.state === 'working' && !stop.pending && canReply ? () => void stop.run(() => actions.interrupt(dorkId)) : undefined}
      />
    </>
  )
}
