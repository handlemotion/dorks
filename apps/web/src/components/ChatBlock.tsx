import { memo, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { BoxIcon, ChevronRightIcon, ImageOffIcon, MessageSquareIcon, UsersIcon, CircleAlertIcon, CircleCheckIcon, CircleStopIcon, ReplyIcon } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Button } from '@dorks/ui/button'
import type { Block } from '@dorks/shared'
import { Bubble, BubbleContent } from '@dorks/ui/bubble'
import { defaultRehypePlugins, defaultUrlTransform, Markdown, markdownComponents } from '@dorks/ui/markdown'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@dorks/ui/context-menu'
import { DropdownMenuItem } from '@dorks/ui/dropdown-menu'
import { HoverActions } from './message-actions/MessageActions'
import { REPLY_SOURCE, ReplyContext, ReplyQuote, SelectionReply, useReply, type ReplyHandlers } from './Reply'
import { parseReply, quoteText } from '../lib/reply'
import { ImageLightbox, ImageTrigger, useLightboxImages, type LightboxImage } from './ImageLightbox'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { INLINE_WIDTH, sizedImage, THUMB_WIDTH } from '../lib/images'
import { Message, MessageContent } from '@dorks/ui/message'
import { toolStep } from '../lib/progress'
import { hookLine } from '../lib/hooks'
import { MessageScrollerItem } from '@dorks/ui/message-scroller'
import { LocalRequestCard } from './LocalRequest'
import { AgentCode } from './CodeBlockCard'
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
    for (const m of text.matchAll(IMAGE)) images.push({ id: `${block.id}:${n++}`, src: m[2], thumb: sizedImage(m[2], THUMB_WIDTH), alt: m[1] || 'Image', caption: m[1] || undefined })
  }
  return images
}

/**
 * A screenshot the agent shared with its `screenshot_share` tool is written `![caption](dorks-image:<id>)`; the bytes live on the
 * server, so the id becomes that server's image URL before the markdown renders.
 */
const SHARED_IMAGE = /\(\s*dorks-image:([0-9a-f]{32})/g
/**
 * Per `imageUrl` (one per server): each resolved URL remembers its id, so a reply to that image can name it to the agent again, and
 * each block resolved once keeps its resolved copy, so a memoized message sees the same block on every render.
 */
const resolved = new WeakMap<(id: string) => string, { refs: Map<string, string>; blocks: WeakMap<Block, Block> }>()
const NO_REFS = new Map<string, string>()
export function resolveSharedImages(blocks: Block[], imageUrl?: (id: string) => string): { blocks: Block[]; refs: Map<string, string> } {
  if (!imageUrl) return { blocks, refs: NO_REFS }
  let cache = resolved.get(imageUrl)
  if (!cache) resolved.set(imageUrl, (cache = { refs: new Map(), blocks: new WeakMap() }))
  const { refs, blocks: done } = cache
  const resolve = (_: string, id: string) => {
    const url = imageUrl(id)
    refs.set(url, `dorks-image:${id}`)
    return `(${url}`
  }
  const one = (b: Block): Block => {
    if ((b.kind !== 'assistant' && b.kind !== 'user') || !b.text.includes('dorks-image:')) return b
    let r = done.get(b)
    if (!r) done.set(b, (r = { ...b, text: b.text.replace(SHARED_IMAGE, resolve) }))
    return r
  }
  return { blocks: blocks.map(one), refs }
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
  // A screenshot that no longer loads (deleted, or on a server that is gone) says so instead of showing a broken image.
  // Keyed by source, so a reused view that gets another image tries to load it.
  const [failedSrc, setFailedSrc] = useState<string | Blob>()
  // A hairline drawn inside the edge, so a white screenshot never melts into the page; the layout does not move.
  const size = `${large ? 'max-h-90 max-w-full h-auto w-auto' : 'h-36 w-auto'} outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`
  const index = typeof src === 'string' ? images.findIndex((i) => i.src === src) : -1
  if (src !== undefined && failedSrc === src) return <ImageUnavailable alt={alt} />
  // Shown from the server's smaller copy: the viewer opens the full image.
  const shown = typeof src === 'string' ? sizedImage(src, large ? INLINE_WIDTH : THUMB_WIDTH) : undefined
  if (index < 0) return shown ? <img src={shown} alt={alt ?? ''} decoding="async" onError={() => setFailedSrc(src)} className={`block ${size} rounded-(--control-radius)`} /> : null
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
          src={shown}
          alt={alt ?? ''}
          decoding="async"
          onError={() => setFailedSrc(src)}
          className={`block ${size} rounded-(--control-radius) bg-surface object-cover`}
        />
      )}
    </ImageTrigger>
  )
}

/** Where an image should be but cannot be shown: its caption, marked as missing, in place of a broken image or a blank space. */
function ImageUnavailable({ alt }: { alt?: string }) {
  return (
    // Plain muted text in the flow of the message, not a box: it reads the same mid-sentence or on a line of its own.
    <span data-testid="image-unavailable" title="This image could not be loaded" className="text-muted-foreground">
      <ImageOffIcon className="mr-1 inline size-[1em] align-[-0.125em]" aria-hidden />
      {alt ? `${alt} (image not available)` : 'Image not available'}
    </span>
  )
}

function AgentImage(props: { src?: string | Blob; alt?: string }) {
  return <ChatImage {...props} large />
}

// Module-level so Streamdown's memo holds; overrides images, unavailable-image spans, and fenced code blocks (Pierre card-on-card).
const MARKDOWN = { ...markdownComponents, img: AgentImage, code: AgentCode, span: MarkdownSpan }

/** A span from the markdown; the ones `markUnavailableImages` left for an image that cannot load become its placeholder. */
function MarkdownSpan({ node: _node, ...props }: ComponentProps<'span'> & { node?: unknown; 'data-image-unavailable'?: string }) {
  if (props['data-image-unavailable'] !== undefined) return <ImageUnavailable alt={props['data-image-unavailable']} />
  return <span {...props} />
}

/**
 * Agents paste screenshots as `data:image/…` URLs. Streamdown drops those twice (its URL transform and its sanitize schema, which
 * allows only http(s) image sources); both are widened for image sources alone. Links and everything else keep the defaults, and
 * the harden step still only lets `data:image/` through.
 */
const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { protocols?: Record<string, string[]> }]
const { harden, ...beforeHarden } = defaultRehypePlugins
const REHYPE = Object.values({
  ...beforeHarden,
  sanitize: [sanitize, { ...schema, protocols: { ...schema.protocols, src: [...(schema.protocols?.src ?? []), 'data'] } }],
  unavailable: markUnavailableImages,
  harden,
}) as (typeof defaultRehypePlugins)[string][]

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** The image sources the harden step lets through (`rehype-harden` with Streamdown's wildcard options): web URLs, same-origin paths, `data:image/`, `blob:`. */
const LOADABLE = /^(?:https?:|blob:|data:image\/|\.{0,2}\/)/i

/**
 * An image the harden step would block (an id the web could not resolve, a bare file name, `file://`) would show as the raw text
 * "[Image blocked: …]". Runs just before it and turns such an image into a span that `MarkdownSpan` shows as a placeholder.
 */
function markUnavailableImages() {
  const walk = (node: HastNode) => {
    for (const [i, child] of (node.children ?? []).entries()) {
      if (child.type === 'element' && child.tagName === 'img') {
        const src = child.properties?.src
        if (typeof src === 'string' && LOADABLE.test(src)) continue
        const alt = typeof child.properties?.alt === 'string' ? child.properties.alt : ''
        node.children![i] = { type: 'element', tagName: 'span', properties: { dataImageUnavailable: alt }, children: [] }
      } else walk(child)
    }
  }
  return walk
}

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

/**
 * A run of tool calls between the agent's messages: one plain line that counts them ("Ran 2 commands, read a file"), its failures
 * after it. The calls themselves live in Progress: with `onOpen` the line is a button, a chevron after it, that opens Progress on
 * them. Where there is no Progress (a narrow window, a worker in a dork's panel) the line unfolds in place to each call and its
 * output instead. It shimmers while one of them runs.
 */
function ToolLine({ tools, onOpen }: { tools: ToolBlock[]; onOpen?: (keys: string[]) => void }) {
  const running = tools.some((t) => t.status === 'running')
  const failed = tools.filter((t) => t.status === 'error').length
  const title = toolGroupTitle(tools)
  const line = (
    // Dim and at the messages' 14px: a pointer over it lifts it a little, never to the full black of the agent's words. Not
    // selectable: copying across the thread picks up only what the agent said.
    <TraceLine status={running ? 'running' : undefined} className="text-(length:--text-message) select-none in-[button:hover]:text-foreground/65">
      <TraceTitle>{title}</TraceTitle>
      {failed > 0 && <span className="shrink-0 text-destructive">{failed === tools.length && failed === 1 ? 'failed' : `${failed} failed`}</span>}
      {onOpen && <ChevronRightIcon aria-hidden className="-ml-1 size-3.5 shrink-0" />}
    </TraceLine>
  )
  return (
    // `my-1.5`: 22px from the text around it, a step more than a paragraph break (19px), so the tool line reads as its own beat.
    <Trace data-testid="tool-steps" className="my-1.5">
      {onOpen ? (
        <button type="button" aria-label={`${title}: show in Progress`} onClick={() => onOpen(tools.map((t) => t.id))}>
          {line}
        </button>
      ) : (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div className="flex flex-col gap-2 pt-2">
              {tools.map((tool) => (
                <ToolCall key={tool.id} block={tool} />
              ))}
            </div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </Trace>
  )
}

/** One call, unfolded under its line where Progress is not at hand: "Ran pnpm test" and its output. */
function ToolCall({ block }: { block: ToolBlock }) {
  const { kind, verb } = toolStep(block.name, block.status)
  const title = kind === 'other' ? `${verb} ${toolAction(block.name).one}${block.summary ? `: ${block.summary}` : ''}` : `${verb} ${block.summary}`
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={`truncate text-sm ${block.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} title={title}>
        {title}
      </span>
      {block.preview && (
        <CodeBlock size="sm" variant={block.status === 'error' ? 'destructive' : 'default'}>
          <CodeBlockContent wrap className="max-h-64">
            {block.preview}
          </CodeBlockContent>
        </CodeBlock>
      )}
    </div>
  )
}

/**
 * One of the agent's messages: unbubbled markdown with its hover toolbar once it has finished streaming. Every message can be copied
 * and replied to; only a final answer is rated.
 */
function AgentText({ block }: { block: Extract<AgentBlock, { kind: 'assistant' }> }) {
  const { onReply } = useReply()
  // The conversation reads at 14px (`text-message`): the agent's replies, the user's bubbles, the tool lines and the status line under them.
  const markdown = <AgentMarkdown className="text-message">{block.text}</AgentMarkdown>
  if (block.streaming) return <div className="min-w-0">{markdown}</div>
  return (
    <HoverActions
      text={block.text}
      sentAt={block.at ? new Date(block.at) : undefined}
      // Only a final answer keeps a line under it for the time: between tool calls that line read as a gap, so there it is in the gutter.
      timeBelow={block.final}
      rate={block.final}
      onReply={onReply && (() => onReply({ kind: 'text', text: quoteText(block.text.replace(IMAGE, '')) }))}
    >
      {markdown}
    </HoverActions>
  )
}

function agentContent(blocks: AgentBlock[], onOpenSteps?: (keys: string[]) => void): ReactNode[] {
  const content: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.kind === 'tool') {
      // Tool calls in a row are one line; the agent's messages split them.
      const tools: ToolBlock[] = [block]
      while (blocks[i + 1]?.kind === 'tool') tools.push(blocks[++i] as ToolBlock)
      content.push(<ToolLine key={tools[0].id} tools={tools} onOpen={onOpenSteps} />)
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
    } else if (block.kind === 'local') {
      // The agent asked to use the owner's computer (docs/local-access.md): the session's one access card, then a line per command.
      content.push(<LocalRequestCard key={block.id} block={block} />)
    } else if (block.kind === 'crew') {
      content.push(<CrewCard key={block.id} block={block} />)
    } else if (block.kind === 'notice') {
      content.push(<Notice key={block.id} block={block} />)
    }
  }
  return content
}

/** A notice; an autonomy event (a PR comment, CI, the agent's PR opened) says what happened in a few words, with the digest on hover. */
function Notice({ block }: { block: Extract<Block, { kind: 'notice' }> }) {
  const line = block.hook ? hookLine(block.hook) : undefined
  const error = block.level === 'error'
  const Icon = line?.icon ?? (error ? CircleAlertIcon : CircleCheckIcon)
  return (
    <Trace role={error ? 'alert' : 'status'} data-testid={line ? 'hook' : undefined}>
      <TraceLine status={error ? 'error' : undefined} title={line ? block.text : undefined}>
        <TraceIcon>
          <Icon />
        </TraceIcon>
        <TraceTitle>{line?.title ?? block.text}</TraceTitle>
      </TraceLine>
    </Trace>
  )
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
 * One turn, in the order it happened: every message the agent wrote, the tool calls between them (a run of calls is one line that
 * opens them in Progress), notices and machine drafts. The agent's thinking never reaches the transcript.
 */
function TurnContent({ blocks, end, onOpenSteps }: { blocks: AgentBlock[]; end?: TurnBlock; onOpenSteps?: (keys: string[]) => void }) {
  return (
    <>
      {agentContent(blocks, onOpenSteps)}
      {end?.outcome === 'stopped' && (
        <Trace role="status" data-testid="turn-stopped">
          <TraceLine>
            <TraceIcon>
              <CircleStopIcon />
            </TraceIcon>
            <TraceTitle>Stopped after {workedFor(end.durationMs)}</TraceTitle>
          </TraceLine>
        </Trace>
      )}
    </>
  )
}

/** The same handler on every render (so memoized messages keep theirs), calling the latest one given; `undefined` stays `undefined`. */
function useStableHandler<A extends unknown[], R>(handler: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  const present = handler !== undefined
  return useMemo(() => (present ? (...args: A) => latest.current!(...args) : undefined), [present])
}

/** The previous list while every image in it is the same, so the lightbox context (and every thumbnail reading it) holds still. */
function useStableImages(images: LightboxImage[]): LightboxImage[] {
  const prev = useRef(images)
  const same =
    prev.current.length === images.length &&
    images.every((i, n) => {
      const p = prev.current[n]
      return p.id === i.id && p.src === i.src && p.alt === i.alt && p.caption === i.caption
    })
  useLayoutEffect(() => {
    if (!same) prev.current = images
  })
  return same ? prev.current : images
}

/** One user message: its bubble, the images it carries and the reply it quotes. Redrawn only when its block changes. */
const UserEntry = memo(function UserEntry({ block, imageUrl }: { block: Extract<Block, { kind: 'user' }>; imageUrl?: (id: string) => string }) {
  const { reply: quoted, body } = parseReply(block.text)
  const text = body.replace(IMAGE, '').trim()
  const own = transcriptImages([block])
  return (
    // A user message gets 12px more air on each side than the transcript's 24px gap, so turns read apart from the agent's work.
    // `pt-10 -mt-7` is that 12px on top plus 28px of paint room for the hover toolbar above the bubble, which the item would
    // otherwise clip. Not a scroll anchor: an anchored message is pinned to the top of the view when sent, and the thread
    // should stay at the bottom with the latest content instead.
    <MessageScrollerItem messageId={block.id} className="-mt-7 pt-10 pb-3">
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
            <HoverActions className="flex w-fit max-w-[80%] flex-col items-end self-end" timeClassName="top-2" text={text} sentAt={block.at ? new Date(block.at) : undefined}>
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
})

/**
 * The agent's work between two user messages. Redrawn only when one of its blocks changes: while the agent streams, only the newest
 * entry does, however long the transcript.
 */
const AgentEntry = memo(
  function AgentEntry({ id, blocks, onOpenSteps }: { id: string; blocks: AgentBlock[]; onOpenSteps?: (keys: string[]) => void }) {
    return (
      // `-mt-7 pt-7 -ml-10 pl-10`: paint room for a first message's hover toolbar and for the times in the left gutter, without
      // moving the layout.
      <MessageScrollerItem messageId={id} className="-mt-7 -ml-10 pt-7 pl-10">
        <Message {...{ [REPLY_SOURCE]: '' }}>
          <MessageContent className="gap-3">
            {turns(blocks).map((turn, i) => (
              <TurnContent key={`${id}:${i}`} blocks={turn.blocks} end={turn.end} onOpenSteps={onOpenSteps} />
            ))}
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    )
  },
  (a, b) => a.id === b.id && a.onOpenSteps === b.onOpenSteps && a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block === b.blocks[i]),
)

/**
 * The transcript. With `onReply` the agent's words can be replied to: select a passage (a small box on it starts the answer), right
 * click an image or use a final answer's Reply. Each becomes a banner in the composer (a selection's box can also send with ⌘ Enter). A sent reply shows its quote above the bubble.
 */
export function ChatMessages({
  blocks: raw,
  imageUrl,
  onReply: replyHandler,
  onReplySend: sendHandler,
  agent,
  onOpenSteps: openSteps,
}: {
  blocks: Block[]
  /** Resolves a shared screenshot's id to its URL. */
  imageUrl?: (id: string) => string
  onReply?: ReplyHandlers['onReply']
  onReplySend?: ReplyHandlers['onSend']
  /** The agent's name, for "Reply to Claude". */
  agent?: string
  /** Opens Progress on these tool calls (a tool line was clicked). Without it the lines are plain text. */
  onOpenSteps?: (keys: string[]) => void
}) {
  // Callers pass fresh closures on every render; the messages get stable ones, so only the ones that changed redraw.
  const onReply = useStableHandler(replyHandler)
  const onReplySend = useStableHandler(sendHandler)
  const onOpenSteps = useStableHandler(openSteps)
  const { blocks, refs } = resolveSharedImages(raw, imageUrl)
  const images = useStableImages(transcriptImages(blocks))
  const reply = useMemo<ReplyHandlers>(() => ({ onReply, onSend: onReplySend, agent, refOf: (src) => refs.get(src) }), [onReply, onReplySend, agent, refs])
  const messages = entries(blocks).map((entry) =>
    entry.kind === 'user' ? <UserEntry key={entry.block.id} block={entry.block} imageUrl={imageUrl} /> : <AgentEntry key={entry.id} id={entry.id} blocks={entry.blocks} onOpenSteps={onOpenSteps} />,
  )
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

/**
 * A crew report or note (docs/crew.md): one line that names the other session, the whole text folded under it. A worker's report is
 * its final answer, so it can run long; the dork's own answer after it says what it means for the goal.
 */
function CrewCard({ block }: { block: Extract<Block, { kind: 'crew' }> }) {
  const peer = block.peer.title
  const title = block.note ? (block.direction === 'in' ? `Note from ${peer}` : `Note to ${peer}`) : block.direction === 'in' ? `Report from ${peer}` : `Reported to ${peer}`
  return (
    <Trace data-crew={block.note ? 'note' : 'report'}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>{block.note ? <MessageSquareIcon /> : <UsersIcon />}</TraceIcon>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p className="pl-6 text-sm whitespace-pre-wrap text-muted-foreground">{block.text}</p>
          {/* The way to a worker on any width: below lg a dork's details (and their Sessions) are hidden. */}
          <div className="pt-2 pl-6">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/dorks" search={{ dork: block.peer.id }} />}>
              Open session
            </Button>
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
