import { useCallback, useEffect, useState } from 'react'
import { PANELS, type TabKey } from './types'

/** Which tabs a details panel has: its panels, where it remembers them, and what a session opens on the first time. */
export type TabsConfig<K extends string> = { storageKey: string; panels: readonly string[]; initial?: () => { keys: K[]; selected: K } }

/**
 * `prs`: the session's pull requests that already got their tab, so each PR opens once, even one the agent added while the panel was
 * closed or another chat was in front. Missing in tabs saved before it was kept: the PRs found then count as already shown.
 */
type OpenTabs<K extends string = TabKey> = { keys: K[]; selected: K; prs?: string[] }
const TABS_KEY = 'dorks.chat-details-tabs.v2.'
const LEGACY_TABS_KEY = 'dorks.chat-details-tabs.'
const newTab = <K extends string>() => `new:${Math.random().toString(36).slice(2, 8)}` as K
/** A chat opens its details on a New tab, the index of what it has; Progress comes up when the thread asks for it. */
function defaultTabs<K extends string>(config: TabsConfig<K>): OpenTabs<K> {
  if (config.initial) return { ...config.initial(), prs: [] }
  const k = newTab<K>()
  return { keys: [k], selected: k, prs: [] }
}
const CHAT_TABS: TabsConfig<TabKey> = { storageKey: TABS_KEY, panels: PANELS }

function parseTabs<K extends string>(raw: string | null, legacy: boolean, panels: readonly string[]): OpenTabs<K> | undefined {
  const saved = JSON.parse(raw ?? 'null') as Partial<OpenTabs<K>> | null
  const isKey = (k: unknown): k is K => typeof k === 'string' && (panels.includes(k) || /^(pr|new):./.test(k))
  const keys = Array.isArray(saved?.keys) ? [...new Set(saved.keys.filter(isKey))] : []
  // Before v2, Progress alone was the default, saved by every chat that opened: read it as no choice at all.
  if (keys.length === 0 || (legacy && keys.length === 1 && keys[0] === 'progress')) return undefined
  const prs = Array.isArray(saved?.prs) ? saved.prs.filter((u): u is string => typeof u === 'string') : undefined
  return { keys, selected: saved?.selected && keys.includes(saved.selected) ? saved.selected : keys[0], prs }
}

function loadTabs<K extends string>(config: TabsConfig<K>, sessionId?: string): OpenTabs<K> {
  if (!sessionId) return defaultTabs(config)
  try {
    const current = localStorage.getItem(config.storageKey + sessionId)
    const legacy = config.storageKey === TABS_KEY ? localStorage.getItem(LEGACY_TABS_KEY + sessionId) : null
    return (current !== null ? parseTabs<K>(current, false, config.panels) : parseTabs<K>(legacy, true, config.panels)) ?? defaultTabs(config)
  } catch {
    return defaultTabs(config)
  }
}

/**
 * The open tabs and the selected one, remembered per session. Opening a tab that is already open focuses it. Chat details by default;
 * a dork's details pass their own panels (`config`, stable across renders).
 */
export function useOpenTabs<K extends string = TabKey>(sessionId?: string, config: TabsConfig<K> = CHAT_TABS as unknown as TabsConfig<K>) {
  const [state, setState] = useState(() => loadTabs(config, sessionId))
  const [loadedFor, setLoadedFor] = useState(sessionId)
  if (loadedFor !== sessionId) {
    setLoadedFor(sessionId)
    setState(loadTabs(config, sessionId))
  }
  useEffect(() => {
    if (!sessionId) return
    try {
      localStorage.setItem(config.storageKey + sessionId, JSON.stringify(state))
    } catch {
      /* private mode: keep it in memory */
    }
  }, [config.storageKey, sessionId, state])
  const open = useCallback((key: K) => setState((s) => (s.keys.includes(key) ? { ...s, selected: key } : { ...s, keys: [...s.keys, key], selected: key })), [])
  /** Opens a tab for each of the session's PRs that has not had one yet (the last one comes up); a PR's tab the owner closed stays closed. */
  const openNewPrs = useCallback(
    (urls: string[]) =>
      setState((s) => {
        if (!s.prs) return { ...s, prs: urls }
        const fresh = urls.filter((u) => !s.prs!.includes(u))
        if (fresh.length === 0) return s
        const added = fresh.map((u) => `pr:${u}` as K).filter((k) => !s.keys.includes(k))
        return { keys: [...s.keys, ...added], selected: `pr:${fresh.at(-1)}` as K, prs: [...s.prs, ...fresh] }
      }),
    [],
  )
  /**
   * Keeps one tab per group (a stack's PRs share one tab): of a group's open tabs, the selected one stays, else the last opened, in
   * the place of the group's first tab. `groupOf` names a key's group, undefined for a tab that stands alone.
   */
  const collapse = useCallback(
    (groupOf: (key: K) => string | undefined) =>
      setState((s) => {
        const members = new Map<string, K[]>()
        for (const k of s.keys) {
          const g = groupOf(k)
          if (g) members.set(g, [...(members.get(g) ?? []), k])
        }
        if (![...members.values()].some((m) => m.length > 1)) return s
        const keeper = (m: K[]) => (m.includes(s.selected) ? s.selected : m.at(-1)!)
        const keys: K[] = []
        for (const k of s.keys) {
          const g = groupOf(k)
          if (!g) keys.push(k)
          else if (members.get(g)![0] === k) keys.push(keeper(members.get(g)!))
        }
        return { ...s, keys, selected: keys.includes(s.selected) ? s.selected : keeper(members.get(groupOf(s.selected)!)!) }
      }),
    [],
  )
  return {
    keys: state.keys,
    collapse,
    selected: state.selected,
    open,
    openNewPrs,
    select: (key: K) => setState((s) => ({ ...s, selected: key })),
    add: () => open(newTab<K>()),
    /** Closing the selected tab selects its neighbour (the next one, else the previous); closing the last leaves a New tab. */
    close: (key: K) =>
      setState((s) => {
        const i = s.keys.indexOf(key)
        const keys = s.keys.filter((k) => k !== key)
        if (keys.length === 0) {
          const k = newTab<K>()
          return { ...s, keys: [k], selected: k }
        }
        return { ...s, keys, selected: s.selected === key ? keys[Math.min(i, keys.length - 1)] : s.selected }
      }),
    /** A New tab becomes what it opened, in its place; if that is already open elsewhere, it is focused there instead. */
    replace: (key: K, target: K) =>
      setState((s) => {
        if (s.keys.includes(target)) return { ...s, keys: s.keys.filter((k) => k !== key), selected: target }
        return { ...s, keys: s.keys.map((k) => (k === key ? target : k)), selected: target }
      }),
  }
}
