import { useSyncExternalStore } from 'react'
import type { Block, NoticeHook } from '@dorks/shared'
import { hookLine } from './hooks'
import { parseReply } from './reply'

export type AgentBlock = Exclude<Block, { kind: 'user' | 'turn' }>
export type ProgressToolBlock = Extract<Block, { kind: 'tool' }>
export type ProgressTextBlock = Extract<Block, { kind: 'assistant' }>

/** One step of a chat's work, as Progress shows it: a tool call, or what the agent said between calls. */
export type ProgressStep = { readonly key: string; readonly block: ProgressToolBlock | ProgressTextBlock }

/** The work the agent did to answer one of the owner's messages. */
export type ProgressTurn = {
  readonly key: string
  /** The message the work answers, or the line for the PR event that started it; `null` for work with no message before it. */
  readonly prompt: string | null
  /** The PR event (docs/autonomy.md) the work answers, when it was not a message. */
  readonly hook?: NoticeHook
  readonly steps: readonly ProgressStep[]
  /** How long it worked, once the turn has ended. */
  readonly durationMs?: number
}

export type WorkBlock = ProgressToolBlock | ProgressTextBlock

/**
 * A turn's blocks split into its opening (the first thing the agent said), its work (tool calls and progress text, which Progress
 * shows) and its answer (the message the thread shows last). The answer is the message the server named final; a turn that ended
 * without one (stopped, failed, or stored before the server named answers) answers with its last message. A running turn has no answer
 * yet. The opening is the turn's first message when it is not also the answer: the thread shows it above the turn's card, so a turn
 * reads as what the agent set out to do, how long it worked, then what it found. Notices and machine drafts are none of these.
 */
export function splitTurn(blocks: readonly Block[], ended: boolean, running = false): { work: WorkBlock[]; answer?: ProgressTextBlock; opening?: ProgressTextBlock } {
  const texts = blocks.filter((b): b is ProgressTextBlock => b.kind === 'assistant')
  const answer = texts.find((b) => b.final) ?? (ended ? texts.at(-1) : undefined)
  // While the chat's last turn runs, its latest text with nothing after it may still become the answer: kept out of the work until a tool
  // call follows it, so it never shows as a step and then vanishes into the thread. Anything after it (a tool call, or the notice an agent
  // that exited mid-turn leaves) releases it.
  const steps = blocks.filter((b): b is WorkBlock => b.kind === 'tool' || b.kind === 'assistant')
  const last = blocks.at(-1)
  const candidate = running && !ended && !answer && last?.kind === 'assistant' ? last : undefined
  // The first text opens the turn. Said before any tool call it shows at once, even as it streams: should it end up the answer, the
  // turn had no work and no card, so it stays where it is. A first text that came after tool calls and may still be the answer waits.
  const first = texts[0]
  const opening = first && first !== answer && (first !== candidate || steps[0] === first) ? first : undefined
  return { work: steps.filter((b) => b !== answer && b !== candidate && b !== opening), answer, opening }
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g

/**
 * The chat's work grouped by turn, in chat order: a user message or a PR event handed to the agent starts one, a `turn` marker ends
 * it. A PR event that lands mid-turn waits for that turn to end (the agent hears it only then). A turn with no work has no entry:
 * there is nothing of it to show. Each turn's key is its first step's, so the thread can point at it.
 */
export function progressTurns(blocks: readonly Block[]): ProgressTurn[] {
  const turns: ProgressTurn[] = []
  let prompt: string | null = null
  let hook: NoticeHook | undefined
  let waiting: NoticeHook | undefined
  let pending: AgentBlock[] = []
  const close = (ended: boolean, durationMs?: number, running = false) => {
    const steps = splitTurn(pending, ended, running).work.map((block) => ({ key: block.id, block }))
    if (steps.length > 0) turns.push({ key: steps[0].key, prompt, steps, durationMs, ...(hook ? { hook } : {}) })
    pending = []
  }
  const startHook = (h: NoticeHook) => {
    hook = h
    prompt = hookLine(h).title
  }
  for (const block of blocks) {
    if (block.kind === 'user') {
      close(false)
      waiting = undefined
      hook = undefined
      prompt = parseReply(block.text).body.replace(IMAGE, '').trim() || null
    } else if (block.kind === 'turn') {
      close(true, block.durationMs)
      if (waiting) startHook(waiting)
      waiting = undefined
    } else if (block.kind === 'notice' && block.hook?.type === 'notify') {
      const working = pending.some((b) => b.kind === 'tool' || b.kind === 'assistant')
      if (working) waiting = block.hook
      else {
        close(false)
        startHook(block.hook)
      }
    } else pending.push(block)
  }
  close(false, undefined, true)
  return turns
}

export const progressSteps = (turns: readonly ProgressTurn[]) => turns.flatMap((turn) => turn.steps)

type ProgressState = {
  /** The step selected in Progress, whose detail shows at its foot; a turn's card in the thread selects its first step. */
  readonly selectedKey: string | null
  /** The steps the thread pointed at (a run of tool calls, the current step): marked in Progress until a step outside them is picked. */
  readonly highlighted: readonly string[]
  /** Bumped when the thread asks for Progress to come up (a tool line or the status line was clicked); Chat details switches to its tab. */
  readonly reveal: number
}

/**
 * The open chat's Progress selection, shared by the thread's turn cards and the panel in Chat details. A store, not context, so a
 * streaming turn re-renders only what reads it.
 */
function createProgressStore() {
  let state: ProgressState = { selectedKey: null, highlighted: [], reveal: 0 }
  const listeners = new Set<() => void>()
  const set = (next: ProgressState) => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Selects a step (its detail opens at the foot of Progress), or nothing (`null`: the foot shows the tasks). */
    select: (selectedKey: string | null) => set({ ...state, selectedKey, highlighted: selectedKey && state.highlighted.includes(selectedKey) ? state.highlighted : [] }),
    /** Opens Progress on these steps: the first selected, all of them marked. With none it only brings Progress up. */
    show: (keys: readonly string[]) => set(keys.length > 0 ? { selectedKey: keys[0], highlighted: keys, reveal: state.reveal + 1 } : { ...state, reveal: state.reveal + 1 }),
    /** A new chat has nothing selected. */
    reset: () => set({ selectedKey: null, highlighted: [], reveal: state.reveal }),
  }
}

export const progressStore = createProgressStore()

export function useProgress() {
  return useSyncExternalStore(progressStore.subscribe, progressStore.get, progressStore.get)
}

/**
 * The step the agent is on, for the status line under the transcript: the newest tool call of the latest turn that is still running,
 * with when it started. A turn with no call running (the agent is writing) has none; `since` is then when the turn began.
 */
export function currentStep(blocks: readonly Block[]): { tool?: ProgressToolBlock; since?: number } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.kind === 'tool' && block.status === 'running') return { tool: block, since: block.at }
    if (block.kind === 'user') return { since: block.at }
    if (block.kind === 'turn') return {}
  }
  return {}
}

/** A running call as the status line says it: a command by its description ("Building the snapshot"), anything else as "Running pnpm test". */
export function stepLabel(block: ProgressToolBlock): string {
  const description = typeof block.input?.description === 'string' ? block.input.description.trim() : ''
  if (description) return description
  const { kind, verb } = toolStep(block.name, block.status)
  if (kind === 'plan' || !block.summary) return verb
  return `${verb} ${block.summary}`
}

/** What a tool does, for a step's title: the verb while it runs and once it ran, and its icon's kind. */
export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'plan' | 'computer' | 'other'

export function toolStep(name: string, status: ProgressToolBlock['status']): { kind: ToolKind; verb: string } {
  const pick = (kind: ToolKind, running: string, done: string, failed = `Failed to ${running.toLowerCase().replace(/ing$/, '')}`) => ({
    kind,
    verb: status === 'running' ? running : status === 'error' ? failed : done,
  })
  if (name.startsWith('mcp__computer__')) return pick('computer', 'Using the computer', 'Used the computer', 'Computer failed')
  switch (name) {
    case 'Bash':
      return pick('command', 'Running', 'Ran', 'Failed to run')
    case 'Read':
      return pick('read', 'Reading', 'Read', 'Failed to read')
    case 'Write':
      return pick('edit', 'Writing', 'Wrote', 'Failed to write')
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('edit', 'Editing', 'Edited', 'Failed to edit')
    case 'Grep':
    case 'Glob':
      return pick('search', 'Searching', 'Searched', 'Search failed')
    case 'WebSearch':
      return pick('web', 'Searching the web', 'Searched the web', 'Web search failed')
    case 'WebFetch':
      return pick('web', 'Fetching', 'Fetched', 'Failed to fetch')
    case 'Task':
    case 'Agent':
      return pick('agent', 'Running an agent', 'Ran an agent', 'Agent failed')
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return pick('plan', 'Updating the plan', 'Updated the plan', 'Plan update failed')
    default:
      return pick('other', 'Using', 'Used', 'Failed')
  }
}

/** An edit a step made, for its diff: one file's text before and after (`before` is empty for a new file). */
export type StepEdit = { path: string; before: string; after: string }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** The edits in an Edit, MultiEdit or Write call's input; none for any other tool, or an input stored before calls kept one. */
export function stepEdits(block: ProgressToolBlock): StepEdit[] {
  const input = block.input
  const path = str(input?.file_path) ?? str(input?.path)
  if (!input || !path) return []
  if (block.name === 'Write') return [{ path, before: '', after: str(input.content) ?? '' }]
  if (block.name === 'Edit') return [{ path, before: str(input.old_string) ?? '', after: str(input.new_string) ?? '' }]
  if (block.name === 'MultiEdit' && Array.isArray(input.edits))
    return input.edits.map((e) => {
      const edit = (e ?? {}) as Record<string, unknown>
      return { path, before: str(edit.old_string) ?? '', after: str(edit.new_string) ?? '' }
    })
  return []
}

/** A step's input as text: a command as written, anything else as formatted JSON. */
export function stepInputText(block: ProgressToolBlock): string | undefined {
  const input = block.input
  if (!input) return undefined
  const command = str(input.command)
  if (command && Object.keys(input).every((k) => k === 'command' || k === 'description' || k === 'timeout')) return command
  return Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : ''
}

/** What a step is, for the filter's `type:` and its row's icon: a tool's kind, or `message` for what the agent said. */
export function stepKind(block: WorkBlock): ToolKind | 'message' {
  return block.kind === 'assistant' ? 'message' : toolStep(block.name, block.status).kind
}

/** A step's status, for the filter's `status:`: what its tool did, or `ok` for a message. */
export function stepStatus(block: WorkBlock): 'running' | 'ok' | 'failed' {
  if (block.kind === 'assistant') return block.streaming ? 'running' : 'ok'
  return block.status === 'error' ? 'failed' : block.status
}

/** Words the filter accepts for a kind, besides the kind itself. */
const KIND_ALIASES: Record<string, ToolKind | 'message'> = { shell: 'command', bash: 'command', file: 'read', write: 'edit', text: 'message', said: 'message' }

/**
 * Whether a step matches the search box: words match its text (command, path, message) and tool name; `type:shell` and
 * `status:failed` match its kind and status; a leading `-` excludes. Every term must hold.
 */
export function matchesFilter(block: WorkBlock, query: string): boolean {
  const haystack = (block.kind === 'assistant' ? block.text : `${block.name} ${block.summary}`).toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((raw) => {
      const negate = raw.startsWith('-') && raw.length > 1
      const term = negate ? raw.slice(1) : raw
      const [key, value] = term.includes(':') ? (term.split(':', 2) as [string, string]) : ['', term]
      const hit = key === 'type' ? stepKind(block) === (KIND_ALIASES[value] ?? value) : key === 'status' ? stepStatus(block) === (value === 'error' ? 'failed' : value) : haystack.includes(term)
      return negate ? !hit : hit
    })
}

/** One of the agent's tasks, from its to-do tools (`TodoWrite`, or `TaskCreate` and `TaskUpdate`). */
export type ProgressTask = { content: string; status: 'pending' | 'in_progress' | 'completed' }

/** The tool calls that change the agent's task list: each run of them in the thread is one to-do card. */
export const TODO_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
export const isTodoTool = (name: string) => TODO_TOOLS.has(name)

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const taskStatus = (v: unknown, fallback: ProgressTask['status']): ProgressTask['status'] => (TASK_STATUSES.has(v as string) ? (v as ProgressTask['status']) : fallback)

/** The task list being folded: tasks by id, the next id `TaskCreate` would get, and which family of tools made the list. */
type TaskFold = { tasks: Map<string, ProgressTask>; next: number; family?: 'todo' | 'task' }

/** A `TodoWrite` replaces the whole list. */
function applyTodoWrite(s: TaskFold, input: Record<string, unknown>): TaskFold {
  if (!Array.isArray(input.todos)) return s
  const tasks = new Map<string, ProgressTask>()
  for (const t of input.todos) {
    const todo = (t ?? {}) as Record<string, unknown>
    const content = str(todo.content)
    if (content) tasks.set(String(tasks.size + 1), { content, status: taskStatus(todo.status, 'pending') })
  }
  return { tasks, next: tasks.size + 1, family: 'todo' }
}

/** A `TaskCreate` adds one task, its id from the result (`Task #3 created successfully`), else the next number. A list `TodoWrite` made is not continued. */
function applyTaskCreate(s: TaskFold, input: Record<string, unknown>, preview: string | undefined): TaskFold {
  const fresh = s.family === 'task'
  const tasks = fresh ? s.tasks : new Map<string, ProgressTask>()
  const next = fresh ? s.next : 1
  const id = /Task #(\S+) created/.exec(preview ?? '')?.[1] ?? String(next)
  const content = str(input.subject) ?? str(input.description)
  if (content) tasks.set(id, { content, status: 'pending' })
  return { tasks, next: /^\d+$/.test(id) ? Math.max(next, Number(id) + 1) : next, family: 'task' }
}

/** A `TaskUpdate` changes one task's status or subject, or deletes it. */
function applyTaskUpdate(s: TaskFold, input: Record<string, unknown>): TaskFold {
  const id = typeof input.taskId === 'number' ? String(input.taskId) : str(input.taskId)
  const task = id ? s.tasks.get(id) : undefined
  if (!id || !task) return s
  if (input.status === 'deleted') s.tasks.delete(id)
  else s.tasks.set(id, { content: str(input.subject) ?? task.content, status: taskStatus(input.status, task.status) })
  return s
}

/**
 * The task list after each run of to-do calls, keyed by the run's first call: what the card at that spot in the thread shows. The
 * list builds up across the whole session. A failed call changes nothing; a call still running counts, so the card moves as the
 * agent works.
 */
export function taskSnapshots(blocks: readonly Block[]): Map<string, ProgressTask[]> {
  const out = new Map<string, ProgressTask[]>()
  let s: TaskFold = { tasks: new Map(), next: 1 }
  let run: string | undefined // the first call of the run of to-do calls we are in
  for (const b of blocks) {
    if (b.kind !== 'tool' || !isTodoTool(b.name)) {
      run = undefined
      continue
    }
    run ??= b.id
    const input = b.input ?? {}
    if (b.status === 'error') {
      // a failed call changes nothing
    } else if (b.name === 'TodoWrite') s = applyTodoWrite(s, input)
    else if (b.name === 'TaskCreate') s = applyTaskCreate(s, input, b.preview)
    else s = applyTaskUpdate(s, input)
    out.set(run, [...s.tasks.values()])
  }
  return out
}

/** The agent's tasks as its newest to-do call left them; none before it made a list. */
export function latestTasks(blocks: readonly Block[]): ProgressTask[] {
  return [...taskSnapshots(blocks).values()].at(-1) ?? []
}
