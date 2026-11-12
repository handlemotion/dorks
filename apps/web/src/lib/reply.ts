/**
 * A reply to part of the agent's work: a passage of its text or one image in the chat. It travels inside the message itself, as a
 * quote above what the owner wrote, so the agent reads what is being answered and nothing changes on the server or bridge:
 *
 *     > Replying to this part of your message:
 *     > The reconnect now waits for the bridge handshake.
 *
 *     Why not back off instead?
 *
 * An image is quoted as `![alt](dorks-image:<id>)`, which the bridge already hands to Claude as an image. The chat parses the quote
 * back out and shows it above the bubble.
 */
export type Reply =
  | { kind: 'text'; text: string }
  /** `src` is what the chat shows; `ref` is the `dorks-image:<id>` the agent can load, when the image has one. */
  | { kind: 'image'; src: string; alt: string; ref?: string }

const TEXT_HEADER = '> Replying to this part of your message:'
const IMAGE_HEADER = '> Replying to this image:'
/** A quote longer than this is cut: the point is to name the passage, not to resend it. */
const MAX_QUOTE = 1500

/** Selected or copied text as one tidy quote: no runs of blank lines, no trailing space, at most {@link MAX_QUOTE} characters. */
export function quoteText(text: string): string {
  const tidy = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return tidy.length > MAX_QUOTE ? `${tidy.slice(0, MAX_QUOTE).trimEnd()}…` : tidy
}

const escapeAlt = (alt: string) => alt.replace(/[[\]\n]/g, ' ').trim() || 'Image'

/** The message as sent: the reply's quote, a blank line, then what the owner wrote. */
export function withReply(reply: Reply | undefined, message: string): string {
  if (!reply) return message
  const quote =
    reply.kind === 'text'
      ? [TEXT_HEADER, ...reply.text.split('\n').map((line) => (line ? `> ${line}` : '>'))]
      : // Only an image the agent can load is quoted as one; anything else (a data URL, a link) is named by its caption.
        [IMAGE_HEADER, reply.ref ? `> ![${escapeAlt(reply.alt)}](${reply.ref})` : `> ${escapeAlt(reply.alt)}`]
  return [quote.join('\n'), message.trim()].filter(Boolean).join('\n\n')
}

/** Splits a sent message into its reply (if it starts with one) and the rest. */
export function parseReply(text: string): { reply?: Reply; body: string } {
  const header = text.startsWith(TEXT_HEADER) ? 'text' : text.startsWith(IMAGE_HEADER) ? 'image' : undefined
  if (!header) return { body: text }
  const lines = text.split('\n')
  let end = 1
  while (end < lines.length && lines[end].startsWith('>')) end++
  const quoted = lines
    .slice(1, end)
    .map((line) => line.replace(/^> ?/, ''))
    .join('\n')
    .trim()
  const body = lines.slice(end).join('\n').trim()
  if (header === 'text') return { reply: { kind: 'text', text: quoted }, body }
  const image = /^!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/.exec(quoted)
  return { reply: image ? { kind: 'image', alt: image[1], src: image[2], ref: image[2] } : { kind: 'image', alt: quoted, src: '' }, body }
}

/** One line naming a reply, for the composer's banner and the sent message. */
export const replyLabel = (reply: Reply) => (reply.kind === 'text' ? reply.text.replace(/\s+/g, ' ') : reply.alt || 'Image')
