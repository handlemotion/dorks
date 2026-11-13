import { useId, useMemo, useState, type ReactNode } from 'react'
import { BoxIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleStopIcon, ReplyIcon, TerminalIcon, WrenchIcon } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Button } from '@dorks/ui/button'
import type { Block } from '@dorks/shared'
import { Bubble, BubbleContent } from '@dorks/ui/bubble'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { defaultRehypePlugins, defaultUrlTransform, Markdown, markdownComponents } from '@dorks/ui/markdown'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@dorks/ui/context-menu'
import { DropdownMenuItem } from '@dorks/ui/dropdown-menu'
import { HoverActions } from './message-actions/MessageActions'
import { REPLY_SOURCE, ReplyContext, ReplyQuote, SelectionReply, useReply, type ReplyHandlers } from './Reply'
import { parseReply, quoteText } from '../lib/reply'
import { ImageLightbox, ImageTrigger, useLightboxImages, type LightboxImage } from './ImageLightbox'
import { Message, MessageContent } from '@dorks/ui/message'
import { MessageScrollerItem } from '@dorks/ui/message-scroller'
import { splitTurn, toolStep, type WorkBlock } from '../lib/progress'
import { TOOL_KIND_ICONS } from './toolIcons'
import { WordShimmer } from './WordShimmer'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'

type ToolBlock = Extract<Block, { kind: 'tool' }>
type TurnBlock = Extract<Block, { kind: 'turn' }>
type AgentBlock = Exclude<Block, { kind: 'user' }>
type Entry = { kind: 'user'; block: Extract<Block, { kind: 'user' }> } | { kind: 'agent'; id: string; blocks: AgentBlock[] }

/** Markdown images (`![alt](src)`), the way agents and users put images in a message. */
const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/** Every image in the transcript, in reading order: they share one lightbox, so opening one pages through the chat's images. */
function transcriptImages(blocks: Block[]): LightboxImage[] {
  const images: LightboxImage[] = []
  for (const block of blocks) {
    if (block.kind !== 'user' && block.kind !== 'assistant') continue
    let n = 0
    const text = block.kind === 'user' ? parseReply(block.text).body : block.text
    for (const m of text.matchAll(IMAGE)) images.push({ id: `${block.id}:${n++}`, src: m[2], alt: m[1] || 'Image', caption: m[1] || undefined })
  }
  return images
}

/**
 * A screenshot the agent shared with its `screenshot_share` tool is written `![caption](dorks-image:<id>)`; the bytes live on the
 * server, so the id becomes that server's image URL before the markdown renders.
 */
const SHARED_IMAGE = /\(\s*dorks-image:([0-9a-f]{32})/g
export function resolveSharedImages(blocks: Block[], imageUrl?: (id: string) => string): { blocks: Block[]; refs: Map<string, string> } {
  // Each resolved URL remembers its id, so a reply to that image can name it to the agent again.
  const refs = new Map<string, string>()
  if (!imageUrl) return { blocks, refs }
  const resolve = (_: string, id: string) => {
    const url = imageUrl(id)
    refs.set(url, `dorks-image:${id}`)
    return `(${url}`
  }
  return { blocks: blocks.map((b) => ((b.kind === 'assistant' || b.kind === 'user') && b.text.includes('dorks-image:') ? { ...b, text: b.text.replace(SHARED_IMAGE, resolve) } : b)), refs }
}

/**
 * An image in a message: a thumbnail that opens the transcript's lightbox on it (or a plain image if it is not in the list). In the
 * agent's messages (`large`) it is big enough to read a screenshot without opening it: up to 360px tall, never wider than the column.
 */
function ChatImage(props: { src?: string | Blob; alt?: string; large?: boolean }) {
  const { onReply, refOf } = useReply()
  const { src, alt } = props
  if (!onReply || typeof src !== 'string') return <ChatImageView {...props} />
  // A right click offers Reply, which puts the image in the composer's banner (and, by its id, in front of the agent).
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="inline-block max-w-full align-top" />}>
        <ChatImageView {...props} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem onClick={() => onReply({ kind: 'image', src, alt: alt || 'Image', ref: src.startsWith('dorks-image:') ? src : refOf?.(src) })}>
          <ReplyIcon />
          Reply
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ChatImageView({ src, alt, large }: { src?: string | Blob; alt?: string; large?: boolean }) {
  const images = useLightboxImages()
  // A hairline drawn inside the edge, so a white screenshot never melts into the page; the layout does not move.
  const size = `${large ? 'max-h-90 max-w-full h-auto w-auto' : 'h-36 w-auto'} outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`
  const index = typeof src === 'string' ? images.findIndex((i) => i.src === src) : -1
  if (index < 0) return typeof src === 'string' ? <img src={src} alt={alt ?? ''} className={`block ${size} rounded-(--control-radius)`} /> : null
  return (
    <ImageTrigger
      index={index}
      className="my-1 inline-block max-w-full cursor-zoom-in rounded-(--control-radius) align-top outline-none focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Open ${alt || 'image'}`}
    >
      {({ imageRef, morphRef }) => (
        <img
          ref={(node) => {
            imageRef(node)
            morphRef(node)
          }}
          src={src as string}
          alt={alt ?? ''}
          className={`block ${size} rounded-(--control-radius) bg-surface object-cover`}
        />
      )}
    </ImageTrigger>
  )
}

function AgentImage(props: { src?: string | Blob; alt?: string }) {
  return <ChatImage {...props} large />
}

// Module-level so Streamdown's memo holds; keeps the package's code blocks.
const MARKDOWN = { ...markdownComponents, img: AgentImage }

/**
 * Agents paste screenshots as `data:image/…` URLs. Streamdown drops those twice (its URL transform and its sanitize schema, which
 * allows only http(s) image sources); both are widened for image sources alone. Links and everything else keep the defaults, and
 * the harden step still only lets `data:image/` through.
 */
const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { protocols?: Record<string, string[]> }]
const REHYPE = Object.values({
  ...defaultRehypePlugins,
  sanitize: [sanitize, { ...schema, protocols: { ...schema.protocols, src: [...(schema.protocols?.src ?? []), 'data'] } }],
}) as (typeof defaultRehypePlugins)[string][]

const allowDataImages: typeof defaultUrlTransform = (url, key, node) => (key === 'src' && url.startsWith('data:image/') ? url : defaultUrlTransform(url, key, node))

/** An agent message's markdown: its images large and openable, inline `data:image/…` screenshots kept. Progress shows messages with it too. */
export function AgentMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Markdown components={MARKDOWN} urlTransform={allowDataImages} rehypePlugins={REHYPE} className={className}>
      {children}
    </Markdown>
  )
}

function entries(blocks: Block[]): Entry[] {
  const result: Entry[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      result.push({ kind: 'user', block })
    } else {
      const last = result.at(-1)
      if (last?.kind === 'agent') last.blocks.push(block)
      else result.push({ kind: 'agent', id: block.id, blocks: [block] })
    }
  }
  return result
}

function ToolRow({ block }: { block: ToolBlock }) {
  const command = block.summary
  const title = block.name === 'Bash' ? `${block.status === 'running' ? 'Running' : block.status === 'error' ? 'Failed to run' : 'Ran'} ${command}` : `${block.name}: ${command}`
  const line = (
    <TraceLine status={block.status === 'ok' ? undefined : block.status}>
      <TraceIcon>
        <TerminalIcon />
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  )
  if (!block.preview) return line
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={block.status === 'error' ? 'destructive' : 'default'}>
          <CodeBlockContent wrap className="max-h-64">
            {block.preview}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** What a tool did, as a verb and a countable noun: "ran" + "command", or a whole phrase when it has no count. */
function toolAction(name: string): { verb: string; one: string; many: string } {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name)
  switch (name) {
    case 'Bash':
      return { verb: 'ran', one: 'a command', many: 'commands' }
    case 'Read':
      return { verb: 'read', one: 'a file', many: 'files' }
    case 'Write':
      return { verb: 'wrote', one: 'a file', many: 'files' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'edited', one: 'a file', many: 'files' }
    case 'Grep':
    case 'Glob':
      return { verb: 'searched', one: 'the code', many: 'the code' }
    case 'WebSearch':
      return { verb: 'searched', one: 'the web', many: 'the web' }
    case 'WebFetch':
      return { verb: 'fetched', one: 'a page', many: 'pages' }
    case 'Task':
    case 'Agent':
      return { verb: 'ran', one: 'an agent', many: 'agents' }
    case 'TodoWrite':
      return { verb: 'updated', one: 'the plan', many: 'the plan' }
    default: {
      const tool = (mcp?.[1] ?? name).replace(/[_-]+/g, ' ')
      return { verb: 'used', one: tool, many: tool }
    }
  }
}

/** "Ran 3 commands, read 2 files, edited a file": a run of tool calls in the order each kind first appeared. */
export function toolGroupTitle(tools: { name: string }[]): string {
  const counts = new Map<string, { verb: string; one: string; many: string; n: number }>()
  for (const { name } of tools) {
    const a = toolAction(name)
    const key = `${a.verb} ${a.many}`
    const seen = counts.get(key)
    if (seen) seen.n++
    else counts.set(key, { ...a, n: 1 })
  }
  const phrases = [...counts.values()].map(({ verb, one, many, n }) => `${verb} ${n === 1 ? one : one === many ? many : `${n} ${many}`}`)
  const text = phrases.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Two or more tool calls in a row: one summary line that opens onto their rows (single calls stay plain rows). */
function ToolGroup({ tools }: { tools: ToolBlock[] }) {
  // Shimmers while a call in it runs; a failed call is red in its own row, not across the whole summary.
  const status = tools.some((t) => t.status === 'running') ? 'running' : undefined
  return (
    <TraceCollapsible data-testid="tool-group">
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>
            <WrenchIcon />
          </TraceIcon>
          <TraceTitle>{toolGroupTitle(tools)}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {tools.map((tool) => (
            <ToolRow key={tool.id} block={tool} />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/**
 * One of the agent's messages: unbubbled markdown with its hover toolbar once it has finished streaming. Every message can be copied
 * and replied to; only a final answer is rated.
 */
function AgentText({ block }: { block: Extract<AgentBlock, { kind: 'assistant' }> }) {
  const { onReply } = useReply()
  // The agent's replies and the user's bubbles are the only text at 14px (`text-message`); the rest of the UI is 13px.
  const markdown = <AgentMarkdown className="text-message">{block.text}</AgentMarkdown>
  if (block.streaming) return <div className="min-w-0">{markdown}</div>
  return (
    <HoverActions
      text={block.text}
      sentAt={block.at ? new Date(block.at) : undefined}
      rate={block.final}
      onReply={onReply && (() => onReply({ kind: 'text', text: quoteText(block.text.replace(IMAGE, '')) }))}
    >
      {markdown}
    </HoverActions>
  )
}

function agentContent(blocks: AgentBlock[]): ReactNode[] {
  const content: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.kind === 'tool') {
      // Tool calls in a row are one group: a lone call is a plain row, two or more fold under one summary line. Progress text splits groups.
      const tools: ToolBlock[] = [block]
      while (blocks[i + 1]?.kind === 'tool') tools.push(blocks[++i] as ToolBlock)
      content.push(
        <Trace key={tools[0].id} data-testid="tool-steps">
          {tools.length === 1 ? <ToolRow block={tools[0]} /> : <ToolGroup tools={tools} />}
        </Trace>,
      )
    } else if (block.kind === 'assistant') {
      // Assistant text is unbubbled markdown, as in the AI Elements chat pattern. No streaming caret: the markdown is a block, so it
      // fell on a line of its own, and the status line below already says the agent is working.
      content.push(<AgentText key={block.id} block={block} />)
    } else if (block.kind === 'build') {
      // The agent asked the owner to approve a change to its machine (docs/builds.md). The diff and the decision live on the build's page.
      const state = block.approved === null ? 'Waiting for you' : block.approved ? 'Approved' : `Rejected${block.reason ? `: ${block.reason}` : ''}`
      content.push(
        <Trace key={block.id} role="status" data-testid="build-draft">
          <TraceLine>
            <TraceIcon>
              <BoxIcon />
            </TraceIcon>
            <TraceTitle>
              Proposed a change to the machine {block.buildName}. {state}.
            </TraceTitle>
          </TraceLine>
          {block.note && <p className="pl-6 text-sm text-muted-foreground">{block.note}</p>}
          {block.buildId && block.approved === null && (
            <div className="pt-2 pl-6">
              <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: block.buildId }} />}>
                Review the change
              </Button>
            </div>
          )}
        </Trace>,
      )
    } else if (block.kind === 'notice') {
      content.push(
        <Trace key={block.id} role={block.level === 'error' ? 'alert' : 'status'}>
          <TraceLine status={block.level === 'error' ? 'error' : undefined}>
            <TraceIcon>{block.level === 'error' ? <CircleAlertIcon /> : <CircleCheckIcon />}</TraceIcon>
            <TraceTitle>{block.text}</TraceTitle>
          </TraceLine>
        </Trace>,
      )
    }
  }
  return content
}

/** A turn's blocks, in order, with the `turn` marker that ended it (none while it is still running). */
function turns(blocks: AgentBlock[]): { blocks: AgentBlock[]; end?: TurnBlock }[] {
  const out: { blocks: AgentBlock[]; end?: TurnBlock }[] = [{ blocks: [] }]
  for (const block of blocks) {
    if (block.kind === 'turn') {
      out[out.length - 1].end = block
      out.push({ blocks: [] })
    } else out[out.length - 1].blocks.push(block)
  }
  return out.filter((t) => t.blocks.length > 0 || t.end?.outcome === 'stopped')
}

/** "12s", "2m 14s", "1h 3m": how long a turn worked. */
export function workedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * A turn's work as one flat sequence, dimmed: progress text, then the tool calls that followed it as one group, and so on. Only where
 * Chat details cannot sit beside the chat (narrow windows); there the turn's card opens it in place.
 */
function WorkHistory({ blocks, id }: { blocks: AgentBlock[]; id?: string }) {
  return (
    <div id={id} data-testid="work-history" className="flex flex-col gap-3 text-muted-foreground">
      {agentContent(blocks)}
    </div>
  )
}

/** The newest step of a running turn, as the card's second line: "Running pnpm test". */
function latestStep(work: WorkBlock[]): string {
  const last = work.at(-1)
  if (!last) return 'Starting'
  if (last.kind === 'assistant')
    return (
      last.text
        .replace(IMAGE, '')
        .split('\n')
        .find((line) => line.trim()) ?? 'Thinking'
    )
  return `${toolStep(last.name, last.status).verb} ${last.summary}`
}

/**
 * A turn's overview, as one row: a chevron, the kinds of tools it used, how long it worked and its step count ("Worked for 2m 14s · 8
 * steps"); while it runs, "Working" and its newest step. The work itself lives in Chat details' Progress; the row opens it there on
 * this turn (`onOpen`), or, without Chat details beside the chat, unfolds it below.
 */
function TurnCard({ work, end, onOpen }: { work: WorkBlock[]; end?: TurnBlock; onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const historyId = useId()
  const tools = work.filter((b): b is ToolBlock => b.kind === 'tool')
  const kinds = [...new Set(tools.map((t) => toolStep(t.name, t.status).kind))].slice(0, 4)
  const running = !end
  const title = running
    ? 'Working'
    : end.outcome === 'stopped'
      ? `Stopped after ${workedFor(end.durationMs)}`
      : end.outcome === 'failed'
        ? `Failed after ${workedFor(end.durationMs)}`
        : `Worked for ${workedFor(end.durationMs)}`
  const detail = running ? latestStep(work) : `${work.length} ${work.length === 1 ? 'step' : 'steps'}`
  const inline = !onOpen
  return (
    <>
      <button
        type="button"
        data-testid="turn-card"
        aria-expanded={inline ? open : undefined}
        aria-controls={inline ? historyId : undefined}
        aria-label={inline ? undefined : `${title}, ${detail}. Show progress`}
        title={tools.length > 0 ? toolGroupTitle(tools) : undefined}
        onClick={() => (onOpen ? onOpen() : setOpen(!open))}
        className="-mx-1 flex h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-(--control-radius) px-1 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon aria-hidden className={`size-3.5 shrink-0 ${inline && open ? 'rotate-90' : ''}`} />
        {kinds.length > 0 && (
          <span aria-hidden className="flex shrink-0 -space-x-1">
            {kinds.map((kind) => {
              const Icon = TOOL_KIND_ICONS[kind]
              return (
                <span key={kind} className="grid size-5 place-items-center rounded-full bg-app ring-2 ring-background">
                  <Icon className="size-3" />
                </span>
              )
            })}
          </span>
        )}
        <span className="shrink-0">{running ? <WordShimmer>{title}</WordShimmer> : title}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate tabular-nums">{detail}</span>
      </button>
      {inline && open && <WorkHistory id={historyId} blocks={work} />}
    </>
  )
}

/**
 * One turn, kept light: the card that sums up its work, then its answer and anything else it posted (notices, a machine draft). The
 * tool calls, edits and progress text are in Progress.
 */
function TurnContent({ blocks, end, onOpenStep }: { blocks: AgentBlock[]; end?: TurnBlock; onOpenStep?: (key: string) => void }) {
  const { work, answer } = splitTurn(blocks, !!end)
  const rest = blocks.filter((b) => b.kind !== 'tool' && b.kind !== 'assistant')
  const first = work[0]
  return (
    <>
      {first && <TurnCard work={work} end={end} onOpen={onOpenStep && (() => onOpenStep(first.id))} />}
      {answer && <AgentText block={answer} />}
      {agentContent(rest)}
      {end?.outcome === 'stopped' && (
        <Trace role="status" data-testid="turn-stopped">
          <TraceLine>
            <TraceIcon>
              <CircleStopIcon />
            </TraceIcon>
            <TraceTitle>Stopped</TraceTitle>
          </TraceLine>
        </Trace>
      )}
    </>
  )
}

/**
 * The transcript. With `onReply` the agent's words can be replied to: select a passage (a small box on it starts the answer), right
 * click an image or use a final answer's Reply. Each becomes a banner in the composer (a selection's box can also send with ⌘ Enter). A sent reply shows its quote above the bubble.
 */
export function ChatMessages({
  blocks: raw,
  imageUrl,
  onReply,
  onReplySend,
  agent,
  onOpenStep,
}: {
  blocks: Block[]
  /** Resolves a shared screenshot's id to its URL. */
  imageUrl?: (id: string) => string
  onReply?: ReplyHandlers['onReply']
  onReplySend?: ReplyHandlers['onSend']
  /** The agent's name, for "Reply to Claude". */
  agent?: string
  /** Opens a turn's work in Chat details' Progress, at its first step. Without it a turn's card unfolds its work in place. */
  onOpenStep?: (key: string) => void
}) {
  const { blocks, refs } = resolveSharedImages(raw, imageUrl)
  const images = transcriptImages(blocks)
  const reply = useMemo<ReplyHandlers>(() => ({ onReply, onSend: onReplySend, agent, refOf: (src) => refs.get(src) }), [onReply, onReplySend, agent, refs])
  const messages = entries(blocks).map((entry) => {
    if (entry.kind === 'user') {
      const { reply: quoted, body } = parseReply(entry.block.text)
      const text = body.replace(IMAGE, '').trim()
      const own = images.filter((i) => i.id.startsWith(`${entry.block.id}:`))
      return (
        // A user message gets 12px more air on each side than the transcript's 24px gap, so turns read apart from the agent's work.
        // `pt-10 -mt-7` is that 12px on top plus 28px of paint room for the hover toolbar above the bubble, which the item would
        // otherwise clip.
        <MessageScrollerItem key={entry.block.id} messageId={entry.block.id} scrollAnchor className="-mt-7 pt-10 pb-3">
          <Message align="end">
            <MessageContent className="items-end">
              {quoted && <ReplyQuote reply={quoted.kind === 'image' && quoted.ref ? { ...quoted, src: resolveRef(quoted.ref, imageUrl) } : quoted} />}
              {own.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  {own.map((image) => (
                    <ChatImage key={image.id} src={image.src} alt={image.alt} />
                  ))}
                </div>
              )}
              {text && (
                <HoverActions className="flex w-fit max-w-[80%] flex-col items-end self-end" timeClassName="top-2" text={text} sentAt={entry.block.at ? new Date(entry.block.at) : undefined}>
                  {/* The wrapper takes the bubble's 80% cap, so it hugs the bubble and the time sits just left of it. */}
                  <Bubble align="end" className="max-w-full">
                    {/* The composer's grey in light, white in dark (see packages/ui/README.md). `!` beats the bubble variant background. */}
                    <BubbleContent className="rounded-[10px]! px-3! py-2! bg-user-bubble! text-(length:--text-message)! text-user-bubble-foreground!">{text}</BubbleContent>
                  </Bubble>
                </HoverActions>
              )}
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )
    }
    return (
      // `-mt-7 pt-7 -ml-10 pl-10`: paint room for a first message's hover toolbar and for the times in the left gutter, without
      // moving the layout.
      <MessageScrollerItem key={entry.id} messageId={entry.id} className="-mt-7 -ml-10 pt-7 pl-10">
        <Message {...{ [REPLY_SOURCE]: '' }}>
          <MessageContent className="gap-3">
            {turns(entry.blocks).map((turn, i) => (
              <TurnContent key={`${entry.id}:${i}`} blocks={turn.blocks} end={turn.end} onOpenStep={onOpenStep} />
            ))}
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    )
  })
  return (
    <ReplyContext.Provider value={reply}>
      {images.length > 0 ? (
        <ImageLightbox images={images} label="Images in this chat">
          {messages}
        </ImageLightbox>
      ) : (
        messages
      )}
      <SelectionReply />
    </ReplyContext.Provider>
  )
}

/** A quoted image's `dorks-image:<id>` as the URL that shows it. */
function resolveRef(ref: string, imageUrl?: (id: string) => string) {
  const id = /^dorks-image:([0-9a-f]{32})$/.exec(ref)?.[1]
  return id && imageUrl ? imageUrl(id) : ref
}
