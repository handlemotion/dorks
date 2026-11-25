import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentModelChoice, DorkMode } from '@dorks/shared'
import { useConnection, useDork, useDorkEvents, useDorksClient, useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@dorks/ui/message-scroller'
import { AgentStatus } from './AgentStatus'
import { ChatMessages } from './ChatBlock'
import { ShipPin } from './ShipCard'
import { ChatToc } from './ChatToc'
import { UsageMenu } from './UsageMenu'
import { useMentions } from './ComposerMenu'
import { Composer, withImages, type AttachedImage, type ModelPicker } from './ChatComposer'
import { LocalAccessProvider } from './LocalRequest'
import type { ModeChoice } from './ModeMenu'
import { QueuedMessages } from './QueuedMessages'
import { SEND_KEY } from './Reply'
import { useDraft } from '../lib/draft'
import { usePending } from '../lib/pending'
import { withReply, type Reply } from '../lib/reply'
import { currentStep, stepLabel } from '../lib/progress'

export type DorkView = NonNullable<ReturnType<typeof useDork>>

/** The session's mode menu (docs/modes.md): a worker keeps the mode its nerd gave it; anything else switches, and the agent restarts with it once its turn ends. */
const sessionMode = (dork: DorkView, change: (mode: DorkMode) => void): ModeChoice => ({
  value: dork.mode ?? 'code',
  ...(dork.parentId ? { lockedReason: 'A worker keeps the mode its nerd gave it' } : { onChange: change }),
})

type SendWith = (deliver: (message: string) => Promise<unknown>) => (images: AttachedImage[]) => Promise<boolean>

/**
 * Steering and the queue. While a turn is running (or about to), Enter sends now and steers it; ⌘ Enter (Ctrl Enter) queues the
 * message for when the turn ends. Queued messages show at the top of the composer, each with Send now and Remove.
 */
function useQueueControls(dork: DorkView, canReply: boolean, sendWith: SendWith) {
  const { actions } = useDorksClient()
  const action = usePending()
  const busy = canReply && (dork.state === 'working' || dork.state === 'creating' || dork.state === 'waking')
  const queue = dork.queue ?? []
  return {
    error: action.error,
    placeholder: busy ? `Enter to steer, ${SEND_KEY} Enter to queue` : undefined,
    onQueue: busy ? sendWith((message) => actions.queueMessage(dork.id, message)) : undefined,
    queued:
      queue.length > 0 ? (
        <QueuedMessages
          queue={queue}
          disabled={action.pending || !canReply}
          onSend={(id) => void action.run(() => actions.takeQueued(dork.id, id, true))}
          onRemove={(id) => void action.run(() => actions.takeQueued(dork.id, id, false))}
        />
      ) : undefined,
  }
}

/**
 * The top of a transcript with older messages: they load on their own once the reader scrolls within a couple of screens of it, so
 * scrolling up rarely meets the end (the scroller keeps the view in place as they come in). The button stays for the keyboard.
 */
function LoadOlder({
  loading,
  paused,
  onLoad,
}: {
  loading: boolean
  /** A read failed: no automatic loads until the feed's own retry succeeds (the button still works). */ paused: boolean
  onLoad: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const load = useRef(onLoad)
  useEffect(() => {
    load.current = onLoad
  })
  // Armed once the reader heads up (or when there is nothing to scroll): opening a chat renders only its newest page.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const viewport = ref.current?.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (armed || !viewport) return
    if (viewport.scrollHeight <= viewport.clientHeight) return setArmed(true)
    let last = viewport.scrollTop
    const onScroll = () => {
      if (viewport.scrollTop < last) setArmed(true)
      last = viewport.scrollTop
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [armed])
  // Observed afresh after each page: a sentinel still in range after one page comes in loads the next, without another scroll.
  useEffect(() => {
    const node = ref.current
    if (!armed || loading || paused || !node) return
    const observer = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && load.current(), {
      root: node.closest('[data-slot="message-scroller-viewport"]'),
      rootMargin: '1600px 0px 0px 0px',
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [armed, loading, paused])
  return (
    <div ref={ref} className="text-center">
      <Button variant="outline" size="sm" onClick={onLoad} disabled={loading}>
        {loading ? 'Loading older…' : 'Load older'}
      </Button>
    </div>
  )
}

export const AGENT_NAMES: Record<DorkView['provider'], string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

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
  const { view, canLoadMore, loadingMore, loadMore, error: eventsError, send } = useDorkEvents(dorkId)
  const own = useDraft(dorkId)
  const [text, setText] = draft ?? own
  const [reply, setReply] = useState<Reply>()
  const { run, pending, error } = usePending()
  const stop = usePending()
  const modelSwitch = usePending()
  const modeSwitch = usePending()
  const settings = useSettings()
  const { live } = useConnection()
  const agent = AGENT_NAMES[dork.provider]
  const mentions = useMentions(dork.provider, dorkId, dork.commands)
  const canReply = !dork.archived
  /** Sends the composer's text (and reply) one way or the other; puts both back if the server refuses. */
  const sendWith: SendWith = (deliver: (message: string) => Promise<unknown>) => (images: Parameters<typeof withImages>[1]) =>
    run(async () => {
      const sent = text
      const quoted = reply
      setText('')
      setReply(undefined)
      try {
        await deliver(withReply(quoted, withImages(sent, images)))
      } catch (e) {
        setText(sent)
        setReply(quoted)
        throw e
      }
    })
  const queueing = useQueueControls(dork, canReply, sendWith)
  const current = dork.state === 'working' ? currentStep(view.blocks) : {}
  const needsAttention =
    Boolean(dork.needsAttention) ||
    view.blocks.some((b) => (b.kind === 'local' && b.status === 'pending') || (b.kind === 'input' && b.status === 'pending') || (b.kind === 'build' && b.approved === null))
  const { blocks, problem } = splitProblem(view.blocks, dork.state)
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          {/* No fade at the bottom edge: the published viewport masks it with scroll-fade-b; the last line stays fully drawn above the composer. */}
          <MessageScrollerViewport aria-label="Session transcript" className="mask-none! [scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
            <MessageScrollerContent className={`mx-auto w-full max-w-4xl gap-6 pt-6 pb-12 ${compact ? 'px-6' : 'px-10'}`} data-testid="transcript">
              {canLoadMore && <LoadOlder loading={loadingMore} paused={!!eventsError} onLoad={loadMore} />}
              <LocalAccessProvider dorkId={dorkId} agent={agent}>
                <ShipPin blocks={blocks} state={dork.state}>
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
                </ShipPin>
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
          <ChatToc blocks={blocks} hidden={compact} />
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <Composer
        text={text}
        setText={setText}
        repo={dork.repo}
        mode={sessionMode(dork, (mode) => void modeSwitch.run(() => actions.setMode(dorkId, mode)))}
        placeholder={queueing.placeholder}
        provider={dork.provider ?? 'claude'}
        pending={pending}
        disabled={dork.archived}
        error={[error, stop.error, queueing.error, extraError, modelSwitch.error, modeSwitch.error].find(Boolean) ?? ''}
        agentLabel={dork.codexModel?.model}
        picker={claudePicker(dork, settings?.claudeModels, (model, effort, fast) => void modelSwitch.run(() => actions.chooseModel(dorkId, model ?? null, effort ?? null, fast)))}
        upload={actions.uploadImage}
        draftKey={dorkId}
        usage={<UsageMenu provider={dork.provider} />}
        mentions={mentions}
        reply={reply}
        onClearReply={() => setReply(undefined)}
        // The optimistic row shows a sent message at once; a queued one shows up in the queue above the text.
        onSubmit={sendWith(send)}
        onQueue={queueing.onQueue}
        queued={queueing.queued}
        onStop={dork.state === 'working' && !stop.pending && canReply ? () => void stop.run(() => actions.interrupt(dorkId)) : undefined}
      />
    </>
  )
}
