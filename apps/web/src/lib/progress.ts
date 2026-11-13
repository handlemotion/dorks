import { useSyncExternalStore } from 'react'
import type { Block } from '@dorks/shared'
import { parseReply } from './reply'

export type AgentBlock = Exclude<Block, { kind: 'user' | 'turn' }>
export type ProgressToolBlock = Extract<Block, { kind: 'tool' }>
export type ProgressTextBlock = Extract<Block, { kind: 'assistant' }>

/** One step of a chat's work, as Progress shows it: a tool call, or what the agent said between calls. */
export type ProgressStep = { readonly key: string; readonly block: ProgressToolBlock | ProgressTextBlock }

/** The work the agent did to answer one of the owner's messages. */
export type ProgressTurn = {
  readonly key: string
  /** The message the work answers; `null` for work with no message before it. */
  readonly prompt: string | null
  readonly steps: readonly ProgressStep[]
  /** How long it worked, once the turn has ended. */
  readonly durationMs?: number
}

export type WorkBlock = ProgressToolBlock | ProgressTextBlock

/**
 * A turn's blocks split into its work (tool calls and progress text, which Progress shows) and its answer (the one message the thread
 * shows). The answer is the message the server named final; a turn that ended without one (stopped, failed, or stored before the
 * server named answers) answers with its last message. A running turn has no answer yet. Notices and machine drafts are neither.
 */
export function splitTurn(blocks: readonly Block[], ended: boolean): { work: WorkBlock[]; answer?: ProgressTextBlock } {
  const texts = blocks.filter((b): b is ProgressTextBlock => b.kind === 'assistant')
  const answer = texts.find((b) => b.final) ?? (ended ? texts.at(-1) : undefined)
  return { work: blocks.filter((b): b is WorkBlock => (b.kind === 'tool' || b.kind === 'assistant') && b !== answer), answer }
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g

/**
 * The chat's work grouped by turn, in chat order: a user message starts one, a `turn` marker ends it. A turn with no work has no
 * entry: there is nothing of it to show. Each turn's key is its first step's, so the thread can point at it.
 */
export function progressTurns(blocks: readonly Block[]): ProgressTurn[] {
  const turns: ProgressTurn[] = []
  let prompt: string | null = null
  let pending: AgentBlock[] = []
  const close = (ended: boolean, durationMs?: number) => {
    const steps = splitTurn(pending, ended).work.map((block) => ({ key: block.id, block }))
    if (steps.length > 0) turns.push({ key: steps[0].key, prompt, steps, durationMs })
    pending = []
  }
  for (const block of blocks) {
    if (block.kind === 'user') {
      close(false)
      prompt = parseReply(block.text).body.replace(IMAGE, '').trim() || null
    } else if (block.kind === 'turn') close(true, block.durationMs)
    else pending.push(block)
  }
  close(false)
  return turns
}

export const progressSteps = (turns: readonly ProgressTurn[]) => turns.flatMap((turn) => turn.steps)

/** The step on screen: the one the owner picked while it is still in the chat, else the newest, so Progress follows a running chat. */
export function progressSelectedIndex(steps: readonly ProgressStep[], selectedKey: string | null) {
  if (steps.length === 0) return -1
  const picked = selectedKey === null ? -1 : steps.findIndex((step) => step.key === selectedKey)
  return picked === -1 ? steps.length - 1 : picked
}

/** The key to keep for a pick: picking the newest step follows the chat again (`null`), any other stays on that step. */
export function progressPick(steps: readonly ProgressStep[], index: number) {
  const clamped = Math.max(0, Math.min(index, steps.length - 1))
  return clamped === steps.length - 1 ? null : (steps[clamped]?.key ?? null)
}

type ProgressState = {
  readonly selectedKey: string | null
  /** Bumped when the thread asks for Progress to come up (a turn's card was clicked); Chat details switches to its tab. */
  readonly reveal: number
}

/**
 * The open chat's Progress selection, shared by the thread's turn cards and the panel in Chat details. A store, not context, so a
 * streaming turn re-renders only what reads it.
 */
function createProgressStore() {
  let state: ProgressState = { selectedKey: null, reveal: 0 }
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
    select: (selectedKey: string | null) => set({ ...state, selectedKey }),
    /** Opens Progress on a step. */
    show: (selectedKey: string | null) => set({ selectedKey, reveal: state.reveal + 1 }),
    /** A new chat starts at its newest step. */
    reset: () => set({ selectedKey: null, reveal: state.reveal }),
  }
}

export const progressStore = createProgressStore()

export function useProgress() {
  return useSyncExternalStore(progressStore.subscribe, progressStore.get, progressStore.get)
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
