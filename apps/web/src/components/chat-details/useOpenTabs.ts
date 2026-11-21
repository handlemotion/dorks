import { useCallback, useEffect, useState } from 'react'
import { PANELS, type TabKey } from './types'

type OpenTabs = { keys: TabKey[]; selected: TabKey }
const TABS_KEY = 'dorks.chat-details-tabs.v2.'
const LEGACY_TABS_KEY = 'dorks.chat-details-tabs.'
const newTab = (): TabKey => `new:${Math.random().toString(36).slice(2, 8)}`
/** A chat opens its details on a New tab, the index of what it has; Progress comes up when the thread asks for it. */
function defaultTabs(): OpenTabs {
  const k = newTab()
  return { keys: [k], selected: k }
}
const isKey = (k: unknown): k is TabKey => typeof k === 'string' && ((PANELS as string[]).includes(k) || /^(pr|new):./.test(k))

function parseTabs(raw: string | null, legacy: boolean): OpenTabs | undefined {
  const saved = JSON.parse(raw ?? 'null') as Partial<OpenTabs> | null
  const keys = Array.isArray(saved?.keys) ? [...new Set(saved.keys.filter(isKey))] : []
  // Before v2, Progress alone was the default, saved by every chat that opened: read it as no choice at all.
  if (keys.length === 0 || (legacy && keys.length === 1 && keys[0] === 'progress')) return undefined
  return { keys, selected: saved?.selected && keys.includes(saved.selected) ? saved.selected : keys[0] }
}

function loadTabs(sessionId?: string): OpenTabs {
  if (!sessionId) return defaultTabs()
  try {
    const current = localStorage.getItem(TABS_KEY + sessionId)
    return (current !== null ? parseTabs(current, false) : parseTabs(localStorage.getItem(LEGACY_TABS_KEY + sessionId), true)) ?? defaultTabs()
  } catch {
    return defaultTabs()
  }
}

/** The open tabs and the selected one, remembered per session. Opening a tab that is already open focuses it. */
export function useOpenTabs(sessionId?: string) {
  const [state, setState] = useState(() => loadTabs(sessionId))
  const [loadedFor, setLoadedFor] = useState(sessionId)
  if (loadedFor !== sessionId) {
    setLoadedFor(sessionId)
    setState(loadTabs(sessionId))
  }
  useEffect(() => {
    if (!sessionId) return
    try {
      localStorage.setItem(TABS_KEY + sessionId, JSON.stringify(state))
    } catch {
      /* private mode: keep it in memory */
    }
  }, [sessionId, state])
  const open = useCallback((key: TabKey) => setState((s) => (s.keys.includes(key) ? { ...s, selected: key } : { keys: [...s.keys, key], selected: key })), [])
  return {
    keys: state.keys,
    selected: state.selected,
    open,
    select: (key: TabKey) => setState((s) => ({ ...s, selected: key })),
    add: () => open(newTab()),
    /** Closing the selected tab selects its neighbour (the next one, else the previous); closing the last leaves a New tab. */
    close: (key: TabKey) =>
      setState((s) => {
        const i = s.keys.indexOf(key)
        const keys = s.keys.filter((k) => k !== key)
        if (keys.length === 0) {
          const k = newTab()
          return { keys: [k], selected: k }
        }
        return { keys, selected: s.selected === key ? keys[Math.min(i, keys.length - 1)] : s.selected }
      }),
    /** A New tab becomes what it opened, in its place; if that is already open elsewhere, it is focused there instead. */
    replace: (key: TabKey, target: TabKey) =>
      setState((s) => {
        if (s.keys.includes(target)) return { keys: s.keys.filter((k) => k !== key), selected: target }
        return { keys: s.keys.map((k) => (k === key ? target : k)), selected: target }
      }),
  }
}
