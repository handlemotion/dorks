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

export type DorkView = NonNullable<ReturnType<typeof useDork>>

/** Claude's model menu for a running session; Codex has none. */
export function claudePicker(dork: DorkView, fallback: AgentModelChoice[] | undefined, onChange: ModelPicker['onChange']): ModelPicker | undefined {
  if (dork.provider !== 'claude') return undefined
  return {
    choices: dork.modelChoices ?? fallback ?? [],
    model: dork.model,
    effort: dork.effort,
    fast: dork.fast,
    active: { model: dork.agentModel, effort: dork.agentEffort },
    onChange,
  }
}

/**
 * A session's conversation: its transcript (the thread, light as everywhere: bubbles, one overview row per turn, final answers) and
 * the composer under it, with Stop, replies and the model menu. The page's chat and a dork's worker panel (CrewDetails) both use it;
 * `compact` is the panel's narrower column.
 */
export function SessionChat({
  dork,
  compact,
  error: extraError,
  onOpenStep,
  draft,
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
  /** A turn's overview row was opened: show its work (Chat details' Progress). Without it, the work unfolds in place. */
  onOpenStep?: (key: string) => void
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
  const agent = dork.provider === 'codex' ? 'Codex' : 'Claude'
  const canReply = !dork.archived
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label="Session transcript" className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
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
                  blocks={view.blocks}
                  imageUrl={actions.imageUrl}
                  agent={agent}
                  onOpenStep={onOpenStep}
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
                <AgentStatus state={dork.state} live={live} outcome={view.lastOutcome} />
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
