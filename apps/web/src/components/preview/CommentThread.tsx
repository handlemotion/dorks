import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUpIcon, CheckIcon, EllipsisIcon, PencilIcon, ReplyIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import type { CommentThread, CommentView } from '@dorks/shared'
import { Avatar, AvatarFallback } from '@dorks/ui/avatar'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { ago } from '../../lib/time'
import { Tip } from '../Tip'

// A comment thread on a running preview, after omni's comments (CommentRow, Message, ReplyBox and ChatBox): an avatar column joined
// by a line, the author, the time and the text, Resolve and a menu on the first message, and a reply box under the last.

/** Who wrote a comment, as the thread shows it. */
export type Names = { owner: string; agent: string }
export const authorName = (c: CommentView, names: Names) => (c.author === 'owner' ? names.owner : names.agent)

/** A text box with Send in its corner; Enter sends, Shift+Enter is a new line. `compact` is one 32px row, for a thread. */
export function ChatBox(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (text: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  label: string
  placeholder: string
  sendLabel: string
  canSend: boolean
  onSend: () => void
  compact?: boolean
}) {
  const compact = props.compact === true
  return (
    <div className="relative flex flex-col rounded-[6px] border border-input bg-background focus-within:border-ring/70">
      <textarea
        ref={props.textareaRef}
        aria-label={props.label}
        placeholder={props.placeholder}
        rows={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          props.onKeyDown?.(e)
          if (e.defaultPrevented) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (props.canSend) props.onSend()
          }
        }}
        className={`field-sizing-content max-h-[40vh] min-h-0 w-full resize-none bg-transparent text-sm/5 outline-none placeholder:text-muted-foreground ${compact ? 'py-1.5 ps-2.5 pe-9' : 'py-2.5 ps-3 pe-11'}`}
      />
      <div className={`absolute ${compact ? 'right-1 bottom-1' : 'right-1.5 bottom-1.5'}`}>
        <Tip label={`${props.sendLabel} ↵`}>
          <Button size="icon-xs" aria-label={props.sendLabel} disabled={!props.canSend} onClick={props.onSend} className="rounded-[6px] bg-brand text-brand-foreground hover:bg-brand-hover">
            <ArrowUpIcon />
          </Button>
        </Tip>
      </div>
    </div>
  )
}

const AVATAR = 'size-6 rounded-[6px] after:rounded-[6px]'

export function Initial({ name, className = '' }: { name: string; className?: string }) {
  return (
    <Avatar className={`${AVATAR} ${className}`}>
      <AvatarFallback className="rounded-[6px] bg-foreground/[0.07] text-xs text-foreground">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}

export type ThreadActions = {
  reply: (threadId: string, body: string) => Promise<unknown>
  resolve: (threadId: string, resolved: boolean) => Promise<unknown>
  edit: (commentId: string, body: string) => Promise<unknown>
  remove: (commentId: string) => Promise<unknown>
}

/** One thread: its messages, Resolve on the first, and a reply box when replying. */
export function CommentRow(props: {
  thread: CommentThread
  names: Names
  actions: ThreadActions
  replying: boolean
  onReplying: (on: boolean) => void
  /** Above the messages: what the thread points at (the quoted text). */
  quote?: ReactNode
}) {
  const { thread, names, actions } = props
  const { root } = thread
  const messages = [root, ...thread.replies]
  const resolved = !!root.resolvedAt
  return (
    <li className="px-3 py-3 not-last:border-b" aria-label={`Comment from ${authorName(root, names)}`}>
      {props.quote}
      <ol>
        {messages.map((comment, index) => (
          <Message
            key={comment.id}
            comment={comment}
            names={names}
            actions={actions}
            joined={index < messages.length - 1 || props.replying}
            onReply={() => props.onReplying(true)}
            lead={
              index === 0 ? (
                <Tip label={resolved ? 'Reopen' : 'Resolve'}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={resolved ? 'Reopen' : 'Resolve'}
                    className="rounded-[6px] text-muted-foreground"
                    onClick={() => void actions.resolve(root.id, !resolved)}
                  >
                    {resolved ? <RotateCcwIcon /> : <CheckIcon />}
                  </Button>
                </Tip>
              ) : undefined
            }
          />
        ))}
        {props.replying && (
          <li className="flex gap-3">
            <span className="pt-1">
              <Initial name={names.owner} />
            </span>
            <div className="min-w-0 flex-1">
              <ReplyBox onSend={(body) => actions.reply(root.id, body)} onCancel={() => props.onReplying(false)} />
            </div>
          </li>
        )}
      </ol>
    </li>
  )
}

function Message(props: { comment: CommentView; names: Names; actions: ThreadActions; joined: boolean; lead?: ReactNode; onReply: () => void }) {
  const { comment, names, actions } = props
  const [editing, setEditing] = useState(false)
  const name = authorName(comment, names)
  const mine = comment.author === 'owner'
  return (
    <li className="group/item flex gap-3">
      <span className="flex shrink-0 flex-col items-center">
        <Initial name={name} />
        {props.joined && <span aria-hidden className="my-1.5 w-px flex-1 bg-border" />}
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 ${props.joined ? 'pb-5' : ''}`}>
        <span className="flex h-6 min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
          <time dateTime={new Date(comment.createdAt).toISOString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {ago(comment.createdAt)}
            {comment.editedAt && ' · edited'}
          </time>
          <span className="ms-auto flex shrink-0 items-center gap-0.5">
            {props.lead}
            {!editing && (
              <DropdownMenu>
                <Tip label="Comment actions">
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Comment actions" className="rounded-[6px] text-muted-foreground" />}>
                    <EllipsisIcon />
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={props.onReply}>
                    <ReplyIcon />
                    Reply
                  </DropdownMenuItem>
                  {mine && (
                    <>
                      <DropdownMenuItem onClick={() => setEditing(true)}>
                        <PencilIcon />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => void actions.remove(comment.id)}>
                        <Trash2Icon />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </span>
        {editing ? (
          <EditBox text={comment.body} onDone={() => setEditing(false)} onSave={(body) => actions.edit(comment.id, body)} />
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap text-foreground">{comment.body}</p>
        )}
      </div>
    </li>
  )
}

function EditBox(props: { text: string; onDone: () => void; onSave: (body: string) => Promise<unknown> }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(props.text)
  useLayoutEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const save = () => {
    const body = text.trim()
    if (!body) return
    if (body !== props.text) void props.onSave(body)
    props.onDone()
  }
  return (
    <ChatBox
      compact
      textareaRef={field}
      label="Edit comment"
      placeholder="Edit comment"
      sendLabel="Save"
      canSend={!!text.trim()}
      onSend={save}
      value={text}
      onChange={setText}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        props.onDone()
      }}
    />
  )
}

function ReplyBox(props: { onSend: (body: string) => Promise<unknown>; onCancel: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const sending = useRef(false)
  useLayoutEffect(() => field.current?.focus(), [])
  const send = () => {
    const body = text.trim()
    if (!body || sending.current) return
    sending.current = true
    props
      .onSend(body)
      .then(() => setText((current) => (current.trim() === body ? '' : current)))
      .catch(() => {})
      .finally(() => {
        sending.current = false
      })
  }
  return (
    <ChatBox
      compact
      textareaRef={field}
      label="Reply"
      placeholder="Reply"
      sendLabel="Send reply"
      canSend={!!text.trim()}
      onSend={send}
      value={text}
      onChange={setText}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        props.onCancel()
      }}
    />
  )
}

/** A new thread's first comment: the box alone, focused, Escape to drop it. */
export function NewComment(props: { onSend: (body: string) => Promise<unknown>; onClose: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  useLayoutEffect(() => field.current?.focus(), [])
  const send = () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    props
      .onSend(body)
      .then(props.onClose)
      .catch(() => setSending(false))
  }
  return (
    <ChatBox
      textareaRef={field}
      label="Comment"
      placeholder="Add a comment…"
      sendLabel="Comment"
      canSend={!!text.trim() && !sending}
      onSend={send}
      value={text}
      onChange={setText}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      }}
    />
  )
}
