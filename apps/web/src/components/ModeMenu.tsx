import type { ComponentType } from 'react'
import { CodeXmlIcon } from 'lucide-react'
import type { DorkMode } from '@dorks/shared'
import { DorkIcon } from './DorkIcon'

// A session's mode (docs/modes.md) is set by where it starts, not by a menu: a nerd from the Nerds group's +, else code. These are the
// modes' marks and the composer's hints.

/** The session's mode, for the composer: what it asks for and whether it needs a repository. */
export interface ModeChoice {
  value: DorkMode
}

/** A nerd's mark is the dork's own (DorkIcon), still. */
const NerdIcon = ({ className }: { className?: string }) => <DorkIcon state="working" still size={14} className={className} />

export const MODE_ICONS: Record<DorkMode, ComponentType<{ className?: string }>> = { code: CodeXmlIcon, nerd: NerdIcon }

/** The box's hint for each mode when the caller gives none. */
export const MODE_HINTS: Record<DorkMode, string> = {
  code: 'Ask the agent to change your code...',
  nerd: 'Give the nerd a goal to plan and delegate...',
}
