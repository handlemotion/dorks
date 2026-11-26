import { useSyncExternalStore } from 'react'
import type { DorkMode } from '@dorks/shared'

/**
 * The app's two workspaces, switched from the title bar: Agents (code sessions and nerds, by repository) and Chat (chats). The sidebar
 * shows one at a time, and New session starts in its mode.
 */
export type AppWorkspace = 'agents' | 'chat'

const KEY = 'dorks.workspace'
const listeners = new Set<() => void>()

function read(): AppWorkspace {
  try {
    return localStorage.getItem(KEY) === 'chat' ? 'chat' : 'agents'
  } catch {
    return 'agents'
  }
}

let current = read()

function setWorkspace(next: AppWorkspace) {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Not remembered; the workspace still applies for this page.
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The workspace a session belongs to: a chat in Chat, everything else (code, nerd) in Agents. */
export const workspaceOf = (mode: DorkMode | undefined): AppWorkspace => (mode === 'chat' ? 'chat' : 'agents')

/** The current workspace, remembered per browser and shared by the title bar's switcher, the sidebar and the new-session page. */
export function useAppWorkspace(): [AppWorkspace, (next: AppWorkspace) => void] {
  return [useSyncExternalStore(subscribe, () => current), setWorkspace]
}
