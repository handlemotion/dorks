import type { SubscriptionView } from '@dorks/shared'
import type { ComputerSource } from '../ComputerView'
import type { PreviewServer } from '../PreviewBrowser'
import type { ProgressTask, ProgressTurn } from '../../lib/progress'
import type { FileChange, PullRequestPanelData } from '../PullRequestPanel'
import type { PrStatusState } from '../PrStatus'
import type { WorkspaceSource } from './Files'

/** A file the agent produced in the chat: a screenshot, a design, a document. */
export type Artifact = {
  id: string
  name: string
  /** Short type label, e.g. "PNG". */ type: string
  src?: string
  /** A smaller copy of `src` for tiles and lists. */
  thumb?: string
  href?: string
  /** The image's `dorks-image` id on the session's server: it can be commented on in the lightbox. */ imageId?: string
  /** Pixel size of an image, when known. */ width?: number
  height?: number
}

/** Everything Chat details can show. Missing parts show an empty state in their tab. */
export type ChatDetailsData = {
  /** The agent's work, by turn: every tool call, edit and progress message, which the thread leaves out. */
  progress?: ProgressTurn[]
  /** The agent's task list, as its latest plan left it. */
  tasks?: ProgressTask[]
  artifacts?: Artifact[]
  changes?: FileChange[]
  pr?: { url: string; number?: number; state?: PrStatusState }
  /** The headline pull request (the latest the agent opened) read live from GitHub, with its merge. */
  pullRequest?: PullRequestPanelData
  /** A hook reading any of the session's other pull requests live by url (stable across renders); without it they show their link only. */
  usePullRequest?: (url: string) => PullRequestPanelData | undefined
  /** The dev servers the agent showed: running previews, tiles in Artifacts that open in place. */
  previews?: PreviewServer[]
  /** The agent's own computer, streamed live in the Computer tab. */
  computer?: ComputerSource
  /** The session runs on the owner's computer (docs/local-dorks.md): it has no screen of its own to stream. */
  local?: boolean
  /** The pull requests the session has (it opened them, or the agent or the owner subscribed; merged and closed ones too): each gets a tab. */
  subscriptions?: SubscriptionView[]
  /** The repositories in the session's sandbox, browsed and edited in the Files tab. */
  workspace?: WorkspaceSource
}

/** A panel Chat details can show in a tab. */
export type Panel = 'progress' | 'artifacts' | 'changes' | 'files' | 'computer'
/** An open tab: a panel, a pull request (by url: a session can hold several) or a New tab. `changes` is the local diff before any PR. */
export type TabKey = Panel | `pr:${string}` | `new:${string}`

export const PANELS: Panel[] = ['progress', 'artifacts', 'changes', 'files', 'computer']
export const PANEL_LABEL: Record<Panel, string> = { progress: 'Progress', artifacts: 'Artifacts', changes: 'Changes', files: 'Files', computer: 'Computer' }
