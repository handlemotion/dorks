import { useState, type ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleStopIcon, ListIcon, TerminalIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import { Bubble, BubbleContent } from '@dorks/ui/bubble'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { defaultRehypePlugins, defaultUrlTransform, Markdown, markdownComponents } from '@dorks/ui/markdown'
import { ImageLightbox, ImageTrigger, useLightboxImages, type LightboxImage } from './ImageLightbox'
import { Message, MessageContent } from '@dorks/ui/message'
import { MessageScrollerItem } from '@dorks/ui/message-scroller'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@dorks/ui/trace'

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
    for (const m of block.text.matchAll(IMAGE)) images.push({ id: `${block.id}:${n++}`, src: m[2], alt: m[1] || 'Image', caption: m[1] || undefined })
  }
  return images
}

/** An image in a message: a thumbnail that opens the transcript's lightbox on it (or a plain image if it is not in the list). */
function ChatImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const images = useLightboxImages()
  const index = typeof src === 'string' ? images.findIndex((i) => i.src === src) : -1
  if (index < 0) return typeof src === 'string' ? <img src={src} alt={alt ?? ''} className="block h-36 w-auto rounded-(--control-radius)" /> : null
  return (
    <ImageTrigger index={index} className="my-1 inline-block cursor-zoom-in rounded-(--control-radius) align-top outline-none focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open ${alt || 'image'}`}>
      {({ imageRef, morphRef }) => <img ref={(node) => { imageRef(node); morphRef(node) }} src={src as string} alt={alt ?? ''} className="block h-36 w-auto rounded-(--control-radius) object-cover" />}
    </ImageTrigger>
  )
}

// Module-level so Streamdown's memo holds; keeps the package's code blocks.
const MARKDOWN = { ...markdownComponents, img: ChatImage }

/**
 * Agents paste screenshots as `data:image/…` URLs. Streamdown drops those twice (its URL transform and its sanitize schema, which
 * allows only http(s) image sources); both are widened for image sources alone. Links and everything else keep the defaults, and
 * the harden step still only lets `data:image/` through.
 */
const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { protocols?: Record<string, string[]> }]
const REHYPE = Object.values({
  ...defaultRehypePlugins,
  sanitize: [sanitize, { ...schema, protocols: { ...schema.protocols, src: [...(schema.protocols?.src ?? []), 'data'] } }],
}) as typeof defaultRehypePlugins[string][]

const allowDataImages: typeof defaultUrlTransform = (url, key, node) => (key === 'src' && url.startsWith('data:image/') ? url : defaultUrlTransform(url, key, node))

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
  const title = block.name === 'Bash'
    ? `${block.status === 'running' ? 'Running' : block.status === 'error' ? 'Failed to run' : 'Ran'} ${command}`
    : `${block.name}: ${command}`
  const line = (
    <TraceLine status={block.status === 'ok' ? undefined : block.status}>
      <TraceIcon><TerminalIcon /></TraceIcon>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  )
  if (!block.preview) return line
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={block.status === 'error' ? 'destructive' : 'default'}>
          <CodeBlockContent wrap className="max-h-64">{block.preview}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function agentContent(blocks: AgentBlock[]): ReactNode[] {
  const content: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.kind === 'tool') {
      const tools: ToolBlock[] = [block]
      while (blocks[i + 1]?.kind === 'tool') tools.push(blocks[++i] as ToolBlock)
      content.push(
        <Trace key={tools[0].id} data-testid="tool-steps">
          {tools.map((tool) => <ToolRow key={tool.id} block={tool} />)}
        </Trace>,
      )
    } else if (block.kind === 'assistant') {
      // Assistant text is unbubbled markdown, as in the AI Elements chat pattern. No streaming caret: the markdown is a block, so it
      // fell on a line of its own, and the status line below already says the agent is working.
      content.push(
        <div key={block.id} className="min-w-0" data-final={block.final ? '' : undefined}>
          <Markdown components={MARKDOWN} urlTransform={allowDataImages} rehypePlugins={REHYPE}>{block.text}</Markdown>
        </div>,
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

/** Progress messages and tool calls are work; the final answer (named by the server) and notices stay in view. */
const isWork = (b: AgentBlock) => b.kind === 'tool' || (b.kind === 'assistant' && !b.final)

/**
 * The turn's work, one collapsed line. Open while the turn runs (so progress is visible), closed once it ends with a final answer;
 * a turn that was stopped or failed, or ended without an answer, stays open so what happened is in view. The user's toggle wins.
 */
function WorkDetails({ blocks, end }: { blocks: AgentBlock[]; end?: TurnBlock }) {
  const running = !end
  const settledOpen = !!end && (end.outcome !== 'done' || !end.finalId)
  const [userOpen, setUserOpen] = useState<boolean>()
  const open = userOpen ?? (running || settledOpen)
  const tools = blocks.filter((b) => b.kind === 'tool').length
  const messages = blocks.length - tools
  const count = [tools && `${tools} ${tools === 1 ? 'step' : 'steps'}`, messages && `${messages} ${messages === 1 ? 'update' : 'updates'}`].filter(Boolean).join(', ')
  const failed = blocks.some((b) => b.kind === 'tool' && b.status === 'error')
  return (
    <Trace data-testid="work-details" data-open={open}>
      <TraceCollapsible open={open} onOpenChange={(next) => setUserOpen(next)}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? 'running' : undefined}>
            <TraceIcon><ListIcon /></TraceIcon>
            <TraceTitle>{running ? 'Working' : 'Work details'}</TraceTitle>
            {count && <TraceDescription>{count}{failed ? ', some failed' : ''}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-3">{agentContent(blocks)}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** One turn: its work collapsed into Work details at the place the work began, then what stays in view, in order. */
function TurnContent({ blocks, end }: { blocks: AgentBlock[]; end?: TurnBlock }) {
  // Turns stored before the server named final answers render as they always did.
  if (end && end.outcome === null) return <>{agentContent(blocks)}</>
  const work = blocks.filter(isWork)
  const content: ReactNode[] = []
  let placed = false
  const visible: AgentBlock[] = []
  const flush = () => {
    if (visible.length) content.push(...agentContent(visible.splice(0)))
  }
  for (const block of blocks) {
    if (isWork(block)) {
      if (!placed) {
        flush()
        content.push(<WorkDetails key={`w${block.id}`} blocks={work} end={end} />)
        placed = true
      }
    } else visible.push(block)
  }
  flush()
  if (end?.outcome === 'stopped') {
    content.push(
      <Trace key={end.id} role="status" data-testid="turn-stopped">
        <TraceLine>
          <TraceIcon><CircleStopIcon /></TraceIcon>
          <TraceTitle>Stopped</TraceTitle>
        </TraceLine>
      </Trace>,
    )
  }
  return <>{content}</>
}

export function ChatMessages({ blocks }: { blocks: Block[] }) {
  const images = transcriptImages(blocks)
  const messages = entries(blocks).map((entry) => {
    if (entry.kind === 'user') {
      const text = entry.block.text.replace(IMAGE, '').trim()
      const own = images.filter((i) => i.id.startsWith(`${entry.block.id}:`))
      return (
        // A user message gets 12px more air on each side than the transcript's 24px gap, so turns read apart from the agent's work.
        <MessageScrollerItem key={entry.block.id} messageId={entry.block.id} scrollAnchor className="py-3">
          <Message align="end">
            <MessageContent className="items-end">
              {own.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  {own.map((image) => <ChatImage key={image.id} src={image.src} alt={image.alt} />)}
                </div>
              )}
              {text && (
                <Bubble align="end">
                  {/* The composer's grey in light, white in dark (see packages/ui/README.md). `!` beats the bubble variant background. */}
                  <BubbleContent className="rounded-[10px]! px-3! py-2! bg-user-bubble! text-user-bubble-foreground!">{text}</BubbleContent>
                </Bubble>
              )}
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )
    }
    return (
      <MessageScrollerItem key={entry.id} messageId={entry.id}>
        <Message>
          <MessageContent className="gap-3">
            {turns(entry.blocks).map((turn, i) => <TurnContent key={`${entry.id}:${i}`} blocks={turn.blocks} end={turn.end} />)}
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    )
  })
  return images.length > 0 ? <ImageLightbox images={images} label="Images in this chat">{messages}</ImageLightbox> : messages
}
