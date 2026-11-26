import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react'
import type { Block } from '@dorks/shared'
import type { AgentModelChoice } from '@dorks/shared'
import { useBuilds, useConnection, useDork, useDorkEvents, useDorksClient, useSettings } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@dorks/ui/message-scroller'
import { AgentStatus } from './AgentStatus'
import { AttentionPill, useAttention } from './AttentionPill'
import { ChatMessages } from './ChatBlock'
import { ShipPin } from './ShipCard'
import { ChatToc } from './ChatToc'
import { UsageMenu } from './UsageMenu'
import { useMentions } from './ComposerMenu'
import { Composer, withImages, type AttachedImage, type ModelPicker } from './ChatComposer'
import { LocalAccessProvider } from './LocalRequest'
import { QueuedMessages } from './QueuedMessages'
import { SEND_KEY } from './Reply'
import { getDraft, useDraft, useDraftSetter } from '../lib/draft'
import { usePending } from '../lib/pending'
import { withReply, type Reply } from '../lib/reply'
import { currentStep, stepLabel } from '../lib/progress'

export type DorkView = NonNullable<ReturnType<typeof useDork>>

/** A session's mode; an older server sends none for code. */
const modeOf = (dork: DorkView) => dork.mode ?? 'code'

/** The build a session runs on, for the composer's bar: its name, null on the base machine, undefined while the builds load. */
const buildName = (dork: DorkView, builds: { id: string; name: string }[] | undefined) => (dork.buildId ? builds?.find((b) => b.id === dork.buildId)?.name : null)

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

/** Keys that scroll a focused transcript. */
const SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home', ' '])

/**
 * The top of a transcript with older messages: they come in on their own once the reader scrolls within a couple of screens of it, so
 * scrolling up rarely meets the end (the scroller keeps the view in place as they come in). Only the reader's own scrolling (wheel,
 * touch, keys) brings them, or a transcript too short to scroll: opening a chat renders only its newest messages, and a jump (the
 * message index) lands where it aimed instead of being pushed away by what loads above it. The button stays for the keyboard.
 */
function LoadOlder({
  loading,
  paused,
  shown,
  onLoad,
}: {
  loading: boolean
  /** A read failed: no automatic loads until the feed's own retry succeeds (the button still works). */ paused: boolean
  /** How many blocks are drawn: the sentinel is looked at again after each step up, even when it never left the margin. */ shown: number
  onLoad: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const load = useRef(onLoad)
  useEffect(() => {
    load.current = onLoad
  })
  // When the reader last scrolled by hand; kept across steps, which each observe the sentinel afresh.
  const intent = useRef(0)
  useEffect(() => {
    const node = ref.current
    const viewport = node?.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (loading || paused || !node || !viewport) return
    let near = false
    const reading = () => viewport.scrollHeight <= viewport.clientHeight || performance.now() - intent.current < 1500
    const maybeLoad = () => near && reading() && load.current()
    const onIntent = (e: Event) => {
      if (e instanceof KeyboardEvent && !SCROLL_KEYS.has(e.key)) return
      intent.current = performance.now()
      maybeLoad()
    }
    const observer = new IntersectionObserver(
      (seen) => {
        near = seen.some((e) => e.isIntersecting)
        maybeLoad()
      },
      { root: viewport, rootMargin: '1600px 0px 0px 0px' },
    )
    observer.observe(node)
    const events = ['wheel', 'touchmove', 'keydown'] as const
    for (const name of events) viewport.addEventListener(name, onIntent, { passive: true })
    return () => {
      observer.disconnect()
      for (const name of events) viewport.removeEventListener(name, onIntent)
    }
  }, [loading, paused, shown])
  return (
    <div ref={ref} className="text-center">
      <Button variant="outline" size="sm" onClick={onLoad} disabled={loading}>
        {loading ? 'Loading older…' : 'Load older'}
      </Button>
    </div>
  )
}

export const AGENT_NAMES: Record<DorkView['provider'], string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

/** The model menu for a running session: Claude's models, the ones OpenCode's providers offer, Antigravity's, or the ChatGPT plan's for Codex. */
export function claudePicker(dork: DorkView, fallback: AgentModelChoice[] | undefined, onChange: ModelPicker['onChange']): ModelPicker | undefined {
  if (dork.provider === 'codex')
    return {
      choices: dork.modelChoices ?? [],
      model: dork.codexModel?.model,
      effort: dork.codexModel?.effort,
      active: { model: dork.agentModel, effort: dork.agentEffort },
      onChange,
    }
  return {
    choices: dork.modelChoices ?? (dork.provider === 'claude' ? fallback : undefined) ?? [],
    model: dork.model,
    effort: dork.effort,
    fast: dork.fast,
    active: { model: dork.agentModel, effort: dork.agentEffort },
    onChange,
  }
}

/** Blocks drawn when a chat opens (cut at a user message when one is near), and how many more each step up adds. */
const WINDOW = 60
const WINDOW_STEP = 120

/** Where a window of at least `size` blocks ending at `end` starts: at the user message that opens its oldest turn, if one comes within another `size`. */
function windowStart(blocks: Block[], end: number, size: number): number {
  const min = end - size
  if (min <= 0) return 0
  for (let i = min; i >= Math.max(0, min - size); i--) if (blocks[i].kind === 'user') return i
  return min
}

/**
 * The part of the transcript that is drawn. Mounting a message is the dear part (markdown, highlighted code, images), so a chat opens
 * with only its newest blocks, and older ones are drawn a step at a time as the reader scrolls up to them: from memory first, then
 * from the server. The next page is fetched ahead, while the chat is idle and again as the last step from memory is drawn, so scrolling
 * up rarely waits on it. The window is pinned by its first block, so new messages at the end never push the oldest drawn one out from
 * under the reader.
 */
function useTranscriptWindow(blocks: Block[], canLoadMore: boolean, loadMore: () => void) {
  const [first, setFirst] = useState<string>()
  const load = useRef(loadMore)
  useEffect(() => {
    load.current = loadMore
  })
  const pinned = first === undefined ? -1 : blocks.findIndex((b) => b.id === first)
  const from = pinned >= 0 ? pinned : windowStart(blocks, blocks.length, WINDOW)
  const startId = blocks[from]?.id
  useEffect(() => {
    if (pinned < 0 && startId && !startId.startsWith('pending-')) setFirst(startId)
  }, [pinned, startId])
  // Nothing older in memory: fetch the next page once the chat is idle, so the first step up is drawn at once.
  useEffect(() => {
    if (from > 0 || !canLoadMore) return
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 300))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => load.current())
    return () => cancel(handle)
  }, [from, canLoadMore])
  const showOlder = () => {
    if (from === 0) return loadMore()
    const next = windowStart(blocks, from, WINDOW_STEP)
    setFirst(blocks[next].id)
    // The last step from memory: fetch the next page now, so it is there when the reader gets to it.
    if (next === 0 && canLoadMore) loadMore()
  }
  /** Draws the transcript down from a little above block `index`, so it can be scrolled to. */
  const reveal = (index: number) => {
    if (index < from) setFirst(blocks[windowStart(blocks, index, 20)].id)
  }
  return { from, hasOlder: from > 0 || canLoadMore, showOlder, reveal }
}

/**
 * Keeps the reader's place while older blocks are drawn above it: the message at the top of the view stays where it was. The browser's
 * own scroll anchoring does this, except at the very top of the scroller (scrollTop 0), which is where a fast scroll up lands; there
 * every step up would leave the view at the top of what was just drawn, and the next step at the top of that, all the way up.
 */
function useKeepPlace(viewport: RefObject<HTMLDivElement | null>, from: number) {
  const place = useRef<{ id: string; top: number }>(undefined)
  useLayoutEffect(() => {
    const kept = place.current
    place.current = undefined
    const el = viewport.current
    if (!kept || !el) return
    const item = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(kept.id)}"]`)
    if (item) el.scrollTop += item.getBoundingClientRect().top - kept.top
  }, [viewport, from])
  /** Notes the message at the top of the view, before a step up draws more above it. */
  return () => {
    const el = viewport.current
    if (!el) return
    const edge = el.getBoundingClientRect().top
    for (const item of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const box = item.getBoundingClientRect()
      if (box.bottom > edge && item.dataset.messageId) return void (place.current = { id: item.dataset.messageId, top: box.top })
    }
  }
}

/** The error that put the Dork in error is said once, in red on the status line, not as its own row above it. */
function splitProblem<B extends { kind: string }>(all: B[], state: string | undefined): { blocks: B[]; problem?: string } {
  const last = all.at(-1) as (B & { level?: string; text?: string }) | undefined
  if (state !== 'error' || last?.kind !== 'notice' || last.level !== 'error') return { blocks: all }
  return { blocks: all.slice(0, -1), problem: last.text }
}

/** The composer, reading its draft: subscribed here, so a keystroke redraws the composer alone. */
function DraftComposer({ draftKey, ...props }: Omit<ComponentProps<typeof Composer>, 'text' | 'setText'> & { draftKey: string }) {
  const [text, setText] = useDraft(draftKey)
  return <Composer {...props} draftKey={draftKey} text={text} setText={setText} />
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
  onOpenSteps,
}: {
  dork: DorkView
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
  // The composer's text is the session's draft (`lib/draft`), which the page also writes into (Chat details' "Ask for…" actions, a
  // picked element). Only the composer reads it as it changes: a keystroke does not redraw the transcript.
  const setText = useDraftSetter(dorkId)
  const [reply, setReply] = useState<Reply>()
  const { run, pending, error } = usePending()
  const stop = usePending()
  const modelSwitch = usePending()
  const settings = useSettings()
  const builds = useBuilds()
  const { live } = useConnection()
  const agent = AGENT_NAMES[dork.provider]
  const mentions = useMentions(dork.provider, dorkId, dork.commands)
  const canReply = !dork.archived
  /** Sends the composer's text (and reply) one way or the other; puts both back if the server refuses. */
  const sendWith: SendWith = (deliver: (message: string) => Promise<unknown>) => (images: Parameters<typeof withImages>[1]) =>
    run(async () => {
      const sent = getDraft(dorkId)
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
  const transcript = useTranscriptWindow(blocks, canLoadMore, loadMore)
  const shown = useMemo(() => (transcript.from > 0 ? blocks.slice(transcript.from) : blocks), [blocks, transcript.from])
  // The Needs action pill: what the agent waits on, and a jump to it (drawing it first when it is above the drawn window).
  const viewport = useRef<HTMLDivElement>(null)
  const attention = useAttention(viewport, needsAttention, blocks, shown, transcript.reveal)
  const keepPlace = useKeepPlace(viewport, transcript.from)
  const showOlder = () => {
    // A step from memory draws above at once; a fetch only adds to memory, drawing nothing.
    if (transcript.from > 0) keepPlace()
    transcript.showOlder()
  }
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          {/* No fade at the bottom edge: the published viewport masks it with scroll-fade-b; the last line stays fully drawn above the composer. */}
          <MessageScrollerViewport ref={viewport} aria-label="Session transcript" className="mask-none! [scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
            <MessageScrollerContent className={`mx-auto w-full max-w-4xl gap-6 pt-6 pb-12 ${compact ? 'px-6' : 'px-10'} [--card-bleed:11px]`} data-testid="transcript">
              {transcript.hasOlder && <LoadOlder loading={loadingMore && transcript.from === 0} paused={!!eventsError} shown={shown.length} onLoad={showOlder} />}
              <LocalAccessProvider dorkId={dorkId} agent={agent}>
                <ShipPin blocks={blocks} state={dork.state}>
                  <ChatMessages
                    blocks={shown}
                    all={blocks}
                    imageUrl={actions.imageUrl}
                    agent={agent}
                    onOpenSteps={onOpenSteps}
                    onReply={canReply ? (quoted, draft) => setReply(draft ? { ...quoted, note: draft } : quoted) : undefined}
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
          <ChatToc blocks={shown} hidden={compact} />
          {/* The scroll-to-end button, and the Needs action pill under it while the agent waits on something out of view. */}
          <AttentionPill viewport={viewport} id={attention.id} revision={shown} onJump={attention.jump} />
        </MessageScroller>
      </MessageScrollerProvider>
      <DraftComposer
        repo={dork.repo}
        build={buildName(dork, builds)}
        local={dork.location === 'local'}
        mode={{ value: modeOf(dork) }}
        placeholder={queueing.placeholder}
        provider={dork.provider ?? 'claude'}
        pending={pending}
        disabled={dork.archived}
        error={[error, stop.error, queueing.error, extraError, modelSwitch.error].find(Boolean) ?? ''}
        agentLabel={dork.codexModel?.model}
        picker={claudePicker(dork, settings?.claudeModels, (model, effort, fast) => void modelSwitch.run(() => actions.chooseModel(dorkId, model ?? null, effort ?? null, fast)))}
        upload={actions.uploadImage}
        draftKey={dorkId}
        // The chat's own composer (not a crew worker's panel) takes the cursor when the chat opens and when the owner starts typing.
        focusKey={compact ? undefined : dorkId}
        typeToFocus={!compact}
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
