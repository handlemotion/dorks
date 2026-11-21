import { useCallback, useEffect, useState } from 'react'
import { PANELS, type TabKey } from './types'

type OpenTabs = { keys: TabKey[]; selected: TabKey }
const TABS_KEY = 'dorks.chat-details-tabs.'
const DEFAULT_TABS: OpenTabs = { keys: ['progress'], selected: 'progress' }
const newTab = (): TabKey => `new:${Math.random().toString(36).slice(2, 8)}`
const isKey = (k: unknown): k is TabKey => typeof k === 'string' && ((PANELS as string[]).includes(k) || /^(pr|new):./.test(k))

function loadTabs(sessionId?: string): OpenTabs {
  if (!sessionId) return DEFAULT_TABS
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY + sessionId) ?? 'null') as Partial<OpenTabs> | null
    const keys = Array.isArray(raw?.keys) ? [...new Set(raw.keys.filter(isKey))] : []
    if (keys.length === 0) return DEFAULT_TABS
    return { keys, selected: raw?.selected && keys.includes(raw.selected) ? raw.selected : keys[0] }
  } catch {
    return DEFAULT_TABS
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
