import type { ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, TerminalIcon } from 'lucide-react'
import type { Block } from '@dorks/shared'
import { Bubble, BubbleContent } from '@dorks/ui/bubble'
import { CodeBlock, CodeBlockContent } from '@dorks/ui/code-block'
import { Markdown } from '@dorks/ui/markdown'
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
type AgentBlock = Exclude<Block, { kind: 'user' }>
type Entry = { kind: 'user'; block: Extract<Block, { kind: 'user' }> } | { kind: 'agent'; id: string; blocks: AgentBlock[] }

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
      // Assistant text is unbubbled markdown, as in the AI Elements chat pattern; the cursor marks a reply still streaming.
      content.push(
        <div key={block.id} className="min-w-0">
          <Markdown>{block.text}</Markdown>
          {block.streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-foreground align-middle" aria-label="Streaming response" />}
        </div>,
      )
    } else {
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

export function ChatMessages({ blocks }: { blocks: Block[] }) {
  return entries(blocks).map((entry) => {
    if (entry.kind === 'user') {
      return (
        <MessageScrollerItem key={entry.block.id} messageId={entry.block.id} scrollAnchor>
          <Message align="end">
            <MessageContent>
              <Bubble align="end">
                {/* White in light and dark; no outline, since white against the panel fill already contrasts 1.2:1 or more (see packages/ui/README.md). `!` beats the bubble variant background. */}
                <BubbleContent className="rounded-[10px]! px-3! py-2! bg-user-bubble! text-user-bubble-foreground!">
                  {entry.block.text}
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )
    }
    return (
      <MessageScrollerItem key={entry.id} messageId={entry.id}>
        <Message>
          <MessageContent className="gap-3">{agentContent(entry.blocks)}</MessageContent>
        </Message>
      </MessageScrollerItem>
    )
  })
}
