import {
  ActivityIcon,
  BotIcon,
  BrainIcon,
  BugIcon,
  ChartColumnIcon,
  CircleHelpIcon,
  CpuIcon,
  DownloadIcon,
  EraserIcon,
  FileIcon,
  FilePlusIcon,
  FoldVerticalIcon,
  FolderPlusIcon,
  GaugeIcon,
  HistoryIcon,
  ImportIcon,
  LayersIcon,
  LightbulbIcon,
  ListTodoIcon,
  LockIcon,
  NotebookTextIcon,
  PaletteIcon,
  PencilIcon,
  PlugIcon,
  PuzzleIcon,
  RefreshCwIcon,
  RepeatIcon,
  RocketIcon,
  ScanEyeIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SignalIcon,
  SparklesIcon,
  SquareTerminalIcon,
  StethoscopeIcon,
  TargetIcon,
  WebhookIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'
import type { AgentCommand } from '@dorks/shared'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useDorksClient, useSkills } from '@dorks/client/react'
import { Command, CommandGroup, CommandItem, CommandList } from '@dorks/ui/command'
import { MENU_POPUP_CLASS } from '@dorks/ui/dropdown-menu'

// The composer's `/` and `@` menus (docs/architecture.md, "Mentions"): typing `/` at the start of a message offers the agent's skills
// and commands, typing `@` after a space (or at the start) offers the repository's files. The menu floats above the box, the text keeps
// focus: arrows move, Enter or Tab picks, Escape closes. Picking replaces what was typed with `/name ` or `@path `.

/** What the composer offers: the agent's commands (or the owner's skills before it has reported any) and a search over the repo's files. */
export interface Mentions {
  commands?: AgentCommand[]
  /** Names of the owner's installed skills: listed under Skills even when the agent does not say where a command comes from. */
  skills?: string[]
  searchFiles?: (query: string) => Promise<string[]>
}

/**
 * What a Claude or Codex session's composer offers: the commands (Codex: skills) its agent reported, else the owner's installed skills
 * until it has, and its repository's files. Other agents get the files only. Without `dorkId` (a new session) there are no files yet.
 */
export function useMentions(provider: string, dorkId?: string, commands?: AgentCommand[]): Mentions {
  const { actions } = useDorksClient()
  const installed = useSkills()
  const searchFiles = useCallback((q: string) => actions.searchFiles(dorkId!, q), [actions, dorkId])
  return useMemo(() => {
    const skills = (installed ?? []).map((s) => s.name)
    const offered = commands?.length ? commands : (installed ?? []).map((s) => ({ name: s.name, description: s.description }))
    return { ...(provider === 'claude' || provider === 'codex' ? { commands: offered, skills } : {}), ...(dorkId ? { searchFiles } : {}) }
  }, [provider, dorkId, commands, installed, searchFiles])
}

type Trigger = { kind: 'command' | 'file'; start: number; query: string }

/** The `/` or `@` token the caret is in, if any: `/` only as the message's first word (where the agent runs it), `@` anywhere. */
export function triggerAt(text: string, caret: number): Trigger | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  const token = text.slice(start, caret)
  if (token.startsWith('@')) return { kind: 'file', start, query: token.slice(1) }
  if (token.startsWith('/') && !text.slice(0, start).trim() && !token.slice(1).includes('/')) return { kind: 'command', start, query: token.slice(1) }
  return null
}

/** Where a command comes from, as Claude Code writes it at the end of its description: `(user)`, `(project)`, a plugin's name. */
const SOURCE = /\s*\((user|project|managed|plugin[^)]*)\)$/
const isSkill = (c: AgentCommand, skills: Set<string>) => skills.has(c.name) || SOURCE.test(c.description ?? '')
const describe = (c: AgentCommand) => (c.description ?? '').replace(SOURCE, '')

/** Commands matching `query`: name prefix, then name, then description; each kind in the agent's own order. */
function matchCommands(commands: AgentCommand[], query: string) {
  const q = query.toLowerCase()
  if (!q) return commands
  const rank = (c: AgentCommand) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : describe(c).toLowerCase().includes(q) ? 2 : -1)
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}

type Item = { value: string; insert: string; group: 'Skills' | 'Commands' | 'Files'; name: string; detail: string }

const fileItems = (files: string[]): Item[] =>
  files.map((p) => {
    const slash = p.lastIndexOf('/')
    return { value: `file:${p}`, insert: `@${p}`, group: 'Files', name: p.slice(slash + 1), detail: slash > 0 ? p.slice(0, slash) : '' }
  })

/** Skills first, then the other commands. */
function commandItems(commands: AgentCommand[], query: string, skills: Set<string>): Item[] {
  const matched = matchCommands(commands, query).slice(0, 100)
  const toItem = (c: AgentCommand, group: Item['group']): Item => ({ value: `cmd:${c.name}`, insert: `/${c.name}`, group, name: `/${c.name}`, detail: describe(c) })
  return [...matched.filter((c) => isSkill(c, skills)).map((c) => toItem(c, 'Skills')), ...matched.filter((c) => !isSkill(c, skills)).map((c) => toItem(c, 'Commands'))]
}

/** The files matching the query, fetched as it changes; the previous answer stays shown until the next one lands. */
function useFileMatches(search: Mentions['searchFiles'], query: string | null) {
  const [files, setFiles] = useState<{ query: string; files: string[] } | null>(null)
  useEffect(() => {
    if (query === null || !search) return
    let live = true
    const t = setTimeout(() => {
      search(query).then(
        (found) => live && setFiles({ query, files: found }),
        () => live && setFiles({ query, files: [] }),
      )
    }, 60)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [search, query])
  return { files: query === null ? [] : (files?.files ?? []), settled: query !== null && files?.query === query }
}

/** A token's identity, so a menu closed with Escape stays closed while the caret is in the same token. */
const keyOf = (t: Trigger | null) => (t ? `${t.kind}:${t.start}` : null)

/** The trigger at the caret when there is something to offer for it: files need a search, `/` needs commands. */
function offeredTrigger(text: string, caret: number | null, mentions?: Mentions): Trigger | null {
  const found = caret === null ? null : triggerAt(text, Math.min(caret, text.length))
  if (!found) return null
  return (found.kind === 'file' ? !!mentions?.searchFiles : !!mentions?.commands?.length) ? found : null
}

/** The text with the typed token replaced by the picked item and one space after it, and where the caret goes. */
function insertItem(text: string, caret: number | null, trigger: Trigger, item: Item) {
  // The whole token is replaced, up to the next space, even when the caret sits inside it.
  let end = Math.min(caret ?? text.length, text.length)
  while (end < text.length && !/\s/.test(text[end]!)) end++
  const rest = text.slice(end)
  const spaced = rest.startsWith(' ')
  const insert = spaced ? item.insert : `${item.insert} `
  return { next: text.slice(0, trigger.start) + insert + rest, at: trigger.start + insert.length + (spaced ? 1 : 0) }
}

/** What a key does while the menu is open: Escape closes it, arrows move, Enter (no modifier) or Tab picks; anything else types. */
function keyAction(e: KeyboardEvent<HTMLTextAreaElement>): 'close' | 'up' | 'down' | 'pick' | null {
  if (e.key === 'Escape') return 'close'
  if (e.key === 'ArrowDown') return 'down'
  if (e.key === 'ArrowUp') return 'up'
  if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || (e.key === 'Tab' && !e.shiftKey)) return 'pick'
  return null
}

/**
 * The menu's state for one textarea. `onKeyDown` returns true when it handled the key (the composer then skips its own Enter);
 * `menu` is the element to render above the box, or null.
 */
export function useComposerMenu({ text, setText, textRef, mentions }: { text: string; setText: (text: string) => void; textRef: RefObject<HTMLTextAreaElement | null>; mentions?: Mentions }) {
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const trigger = offeredTrigger(text, caret, mentions)
  const key = keyOf(trigger)
  const open = !!trigger && key !== dismissed
  const { files, settled } = useFileMatches(mentions?.searchFiles, open && trigger?.kind === 'file' ? trigger.query : null)
  const skills = useMemo(() => new Set(mentions?.skills ?? []), [mentions?.skills])

  const items = useMemo(
    () => (open && trigger ? (trigger.kind === 'file' ? fileItems(files) : commandItems(mentions?.commands ?? [], trigger.query, skills)) : []),
    [open, trigger?.kind, trigger?.query, files, mentions?.commands, skills],
  )

  // The first row is active whenever the list changes under it.
  const current = items.find((i) => i.value === active) ?? items[0]
  useEffect(() => {
    listRef.current?.querySelector('[data-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [current?.value])

  const pick = (item: Item) => {
    if (!trigger) return
    const { next, at } = insertItem(text, caret, trigger, item)
    setText(next)
    setCaret(at)
    setDismissed(keyOf(trigger))
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(at, at)
    })
  }

  /** Follows the caret: call from the textarea's change, select, click and key-up. */
  const track = () => {
    const el = textRef.current
    if (!el) return
    const at = el.selectionStart === el.selectionEnd ? el.selectionStart : null
    setCaret(at)
    // A dismissed menu comes back once the caret leaves its token.
    if (dismissed && (at === null || keyOf(triggerAt(el.value, at)) !== dismissed)) setDismissed(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    const action = keyAction(e)
    if (!action || (action !== 'close' && !items.length)) return false
    e.preventDefault()
    if (action === 'close') setDismissed(key)
    else if (action === 'pick') pick(current ?? items[0]!)
    else {
      const i = current ? items.indexOf(current) : 0
      setActive(items[(i + (action === 'down' ? 1 : items.length - 1)) % items.length]!.value)
    }
    return true
  }

  const listId = useId()
  // Shown once there is an answer for what was typed: rows, or No matches (a file search still on its way shows the last rows).
  const shown = open && (items.length > 0 || trigger?.kind === 'command' || settled)
  const menu = shown ? <ComposerMenuList listRef={listRef} id={listId} items={items} active={current?.value ?? ''} setActive={setActive} pick={pick} /> : null
  return {
    menu,
    track,
    /** The text lost focus: the menu closes (a press on the menu itself keeps the focus). */
    blur: () => setCaret(null),
    onKeyDown,
    // The textarea is the combobox the menu belongs to.
    inputProps: { role: 'combobox', 'aria-expanded': !!menu, 'aria-controls': menu ? listId : undefined, 'aria-autocomplete': 'list' as const },
  }
}

const ROW = 'h-8 gap-2 rounded-[6px] px-2 py-0 font-normal data-selected:bg-foreground/[0.05] transition-none [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground'
/** Claude Code's built-in commands by what they do; any other command gets a terminal. Skills are all sparkles, files all files. */
const COMMAND_ICON: Record<string, LucideIcon> = {
  compact: FoldVerticalIcon,
  autocompact: FoldVerticalIcon,
  context: GaugeIcon,
  init: FilePlusIcon,
  clear: EraserIcon,
  model: CpuIcon,
  effort: SignalIcon,
  fast: ZapIcon,
  config: SettingsIcon,
  mcp: PlugIcon,
  usage: ChartColumnIcon,
  cost: ChartColumnIcon,
  'security-review': ShieldCheckIcon,
  review: ScanEyeIcon,
  agents: BotIcon,
  'list-agents': BotIcon,
  memory: BrainIcon,
  rename: PencilIcon,
  resume: HistoryIcon,
  loop: RepeatIcon,
  goal: TargetIcon,
  debug: BugIcon,
  doctor: StethoscopeIcon,
  'skill-doctor': StethoscopeIcon,
  hooks: WebhookIcon,
  permissions: LockIcon,
  'output-style': PaletteIcon,
  color: PaletteIcon,
  export: DownloadIcon,
  import: ImportIcon,
  help: CircleHelpIcon,
  status: ActivityIcon,
  todos: ListTodoIcon,
  'add-dir': FolderPlusIcon,
  'reload-plugins': PuzzleIcon,
  'reload-skills': RefreshCwIcon,
  batch: LayersIcon,
  recap: NotebookTextIcon,
  insights: NotebookTextIcon,
  advisor: LightbulbIcon,
  ship: RocketIcon,
}
function ItemIcon({ item }: { item: Item }) {
  const Icon = item.group === 'Files' ? FileIcon : item.group === 'Skills' ? SparklesIcon : (COMMAND_ICON[item.name.slice(1)] ?? SquareTerminalIcon)
  return <Icon />
}

/** The dropdown look with the focused composer's border, since the menu belongs to the box being typed in; one height, so it never jumps as it filters. */
const POPUP = MENU_POPUP_CLASS.replace('border-border', 'border-ring')

/** The menu itself: the app's dropdown look (hairline, soft shadow, 32px rows), titled groups, the active row filled. */
function ComposerMenuList({
  listRef,
  id,
  items,
  active,
  setActive,
  pick,
}: {
  listRef: RefObject<HTMLDivElement | null>
  id: string
  items: Item[]
  active: string
  setActive: (value: string) => void
  pick: (item: Item) => void
}) {
  const groups = (['Skills', 'Commands', 'Files'] as const).map((g) => [g, items.filter((i) => i.group === g)] as const).filter(([, list]) => list.length > 0)
  return (
    // The text keeps focus: a press on the menu must not blur it.
    <div data-testid="composer-menu" className="absolute inset-x-0 bottom-full z-50 mb-2" onMouseDown={(e) => e.preventDefault()}>
      <Command shouldFilter={false} value={active} onValueChange={setActive} className={`${POPUP} h-72 gap-0 p-0`}>
        <CommandList ref={listRef} id={id} className="h-full max-h-none p-1">
          {items.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches</p>}
          {groups.map(([group, list]) => {
            return (
              <CommandGroup key={group} heading={group} className="p-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:font-normal">
                {list.map((item) => (
                  <CommandItem key={item.value} value={item.value} onSelect={() => pick(item)} className={ROW}>
                    <ItemIcon item={item} />
                    <span className={`shrink-0 truncate ${group === 'Files' ? 'max-w-[60%]' : 'max-w-[45%]'}`}>{item.name}</span>
                    {item.detail && <span className={`min-w-0 flex-1 truncate text-muted-foreground ${group === 'Files' ? 'font-mono text-xs' : ''}`}>{item.detail}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}
        </CommandList>
      </Command>
    </div>
  )
}
