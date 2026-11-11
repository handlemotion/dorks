import { useId, useState, type ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleStopIcon, TerminalIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import { Bubble, BubbleContent } from '@dorks/ui/bubble'
import { Marker, MarkerContent } from '@dorks/ui/marker'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { defaultRehypePlugins, defaultUrlTransform, Markdown, markdownComponents } from '@dorks/ui/markdown'
import { MessageActions } from './message-actions/MessageActions'
import { ImageLightbox, ImageTrigger, useLightboxImages, type LightboxImage } from './ImageLightbox'
import { Message, MessageContent } from '@dorks/ui/message'
import { MessageScrollerItem } from '@dorks/ui/message-scroller'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
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
      // Tool calls in a row are one group (one AI Elements Trace); progress text between them is what splits groups.
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

/** "12s", "2m 14s", "1h 3m": how long a turn worked. */
export function workedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * A turn's work as one flat sequence: progress text, then the tool calls that followed it as one group, and so on, plus notices.
 * Nothing nests inside a parent step, and nothing divides the steps: spacing does. The turn's checkpoint above is its only line.
 */
function WorkHistory({ blocks, dimmed, id }: { blocks: AgentBlock[]; dimmed?: boolean; id?: string }) {
  return (
    <div id={id} data-testid="work-history" data-dimmed={dimmed ? '' : undefined} className={`flex flex-col gap-3 ${dimmed ? 'text-muted-foreground' : ''}`}>
      {agentContent(blocks)}
    </div>
  )
}

/**
 * The AI Elements Checkpoint's separator marker (`@dorks/ui/marker`): a line with a label in it, and the turn's only divider. The bar
 * itself is the toggle once the turn has ended (a real button, so it takes focus and Enter/Space); while the turn runs it only marks
 * where the work starts and cannot be collapsed.
 */
function TurnCheckpoint({ label, open, onToggle, controls }: { label: string; open: boolean; onToggle?: () => void; controls: string }) {
  if (!onToggle) return (
    <Marker variant="separator" data-testid="turn-checkpoint">
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  )
  return (
    <Marker
      variant="separator"
      data-testid="turn-checkpoint"
      render={<button type="button" />}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="cursor-pointer select-none rounded-[var(--control-radius)] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  )
}

/**
 * One turn. While it runs: a "Working" checkpoint, then its work live as it happens, always open. Once it ends with a final answer
 * the work folds behind the same checkpoint, now "Worked for 2m 14s" (click the bar to open it, shown dimmed), then the final answer
 * and any notices. A turn that was stopped or failed, or ended without a final answer, opens its history so what happened is in
 * view. The user's toggle wins.
 */
function TurnContent({ blocks, end }: { blocks: AgentBlock[]; end?: TurnBlock }) {
  const [userOpen, setUserOpen] = useState<boolean>()
  const historyId = useId()
  // Turns stored before the server named final answers render as they always did.
  if (end && end.outcome === null) return <>{agentContent(blocks)}</>
  if (!end) return (
    <>
      <TurnCheckpoint label="Working" open controls={historyId} />
      <WorkHistory id={historyId} blocks={blocks} />
    </>
  )
  const work = blocks.filter(isWork)
  const open = userOpen ?? (end.outcome !== 'done' || !end.finalId)
  const final = blocks.find((b): b is Extract<AgentBlock, { kind: 'assistant' }> => b.kind === 'assistant' && b.id === end.finalId)
  return (
    <>
      {work.length > 0 && (
        <>
          <TurnCheckpoint label={`Worked for ${workedFor(end.durationMs)}`} open={open} onToggle={() => setUserOpen(!open)} controls={historyId} />
          {open && <WorkHistory id={historyId} blocks={work} dimmed />}
        </>
      )}
      {agentContent(blocks.filter((b) => !isWork(b)))}
      {/* The final answer's actions: rate, copy, react, reply, 16px under the text (the transcript's 12px gap plus `mt-1`). The buttons' edge sits on the
          text's edge: the message item paints with `content-visibility: auto`, which clips anything pulled outside it. */}
      {final && <div className="mt-1"><MessageActions text={final.text} sentAt={new Date(end.at)} /></div>}
      {end.outcome === 'stopped' && (
        <Trace role="status" data-testid="turn-stopped">
          <TraceLine>
            <TraceIcon><CircleStopIcon /></TraceIcon>
            <TraceTitle>Stopped</TraceTitle>
          </TraceLine>
        </Trace>
      )}
    </>
  )
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
