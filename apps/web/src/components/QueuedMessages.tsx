import { ArrowUpIcon, ClockIcon, XIcon } from 'lucide-react'
import type { QueuedMessage } from '@dorks/client'
import { InputGroupButton } from '@dorks/ui/input-group'
import { parseReply } from '../lib/reply'
import { Tip } from './Tip'

const IMAGE = /!\[[^\]]*\]\(\s*dorks-image:[0-9a-f]{32}\s*\)/g

/** A queued message on one line: what the owner wrote, without the reply's quote, and its images as a count. */
function queuedLabel(text: string) {
  const { body } = parseReply(text)
  const images = body.match(IMAGE)?.length ?? 0
  const words = body.replace(IMAGE, ' ').replace(/\s+/g, ' ').trim()
  const extra = images ? `${images} ${images === 1 ? 'image' : 'images'}` : ''
  return [words, extra && (words ? `+ ${extra}` : extra)].filter(Boolean).join(' ') || 'Message'
}

/**
 * Messages queued with ⌘ Enter, oldest first, as plain rows in the frame above the composer's white box (the reply banner's card is
 * for replies only): each waits for the
 * agent's current turn to end and then goes out as a turn of its own. The arrow sends one now instead, steering the running turn.
 */
export function QueuedMessages({ queue, onSend, onRemove, disabled }: { queue: QueuedMessage[]; onSend: (id: string) => void; onRemove: (id: string) => void; disabled?: boolean }) {
  return (
    <ol aria-label="Queued messages" data-testid="composer-queue" className="flex w-full min-w-0 flex-col py-1">
      {queue.map((q) => (
        <li key={q.id} className="flex h-8 w-full min-w-0 items-center gap-1 pr-2 pl-4 text-[13px] text-muted-foreground">
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span title={q.text} className="min-w-0 flex-1 truncate pl-2 text-left text-foreground/80">
            {queuedLabel(q.text)}
          </span>
          <Tip label="Send now (steers the current turn)">
            <InputGroupButton
              size="icon-xs"
              variant="ghost"
              aria-label="Send now"
              disabled={disabled}
              onClick={() => onSend(q.id)}
              className="shrink-0 rounded-[6px] text-muted-foreground hover:text-foreground [--control-radius:6px]"
            >
              <ArrowUpIcon />
            </InputGroupButton>
          </Tip>
          <Tip label="Remove from queue">
            <InputGroupButton
              size="icon-xs"
              variant="ghost"
              aria-label="Remove from queue"
              disabled={disabled}
              onClick={() => onRemove(q.id)}
              className="shrink-0 rounded-[6px] text-muted-foreground hover:text-foreground [--control-radius:6px]"
            >
              <XIcon />
            </InputGroupButton>
          </Tip>
        </li>
      ))}
    </ol>
  )
}
