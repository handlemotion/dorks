import type { ComponentType } from 'react'
import { BotIcon, FilePenLineIcon, FileTextIcon, GlobeIcon, ListTodoIcon, MonitorIcon, SearchIcon, TerminalIcon, WrenchIcon } from 'lucide-react'
import type { ToolKind } from '../lib/progress'

/** The icon for each kind of tool: a Progress step's title and a turn card's icon stack. */
export const TOOL_KIND_ICONS: Record<ToolKind, ComponentType<{ className?: string }>> = {
  command: TerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  plan: ListTodoIcon,
  computer: MonitorIcon,
  other: WrenchIcon,
}
