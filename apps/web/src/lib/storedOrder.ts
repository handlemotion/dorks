import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** Same-tab subscribers; other tabs are heard through the `storage` event. */
const listeners = new Set<() => void>()
/** Orders that could not be written (storage full or disabled), so they still hold for this session. */
const unsaved = new Map<string, string>()

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

function read(key: string): string | null {
  const pending = unsaved.get(key)
  if (pending !== undefined) return pending
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    unsaved.delete(key)
  } catch {
    unsaved.set(key, value)
  }
  for (const notify of listeners) notify()
}

function parse(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // unreadable value: start from the default order
  }
}

/**
 * A user-chosen order for a list of ids, kept in localStorage (the backend has no ordering yet, so it is per browser) and
 * shared live across tabs. Ids not seen before (new chats) go first, as the list arrives newest-first; ids that no longer
 * exist are ignored. Read during render on the client, so there is no flash of the default order; the server renders it.
 */
export function useStoredOrder(storageKey: string, ids: string[]) {
  const raw = useSyncExternalStore(subscribe, () => read(storageKey), () => null)
  const stored = useMemo(() => parse(raw), [raw])
  const present = new Set(ids)
  const known = new Set(stored)
  const ordered = [...ids.filter((id) => !known.has(id)), ...stored.filter((id) => present.has(id))]
  const commit = useCallback((next: string[]) => write(storageKey, JSON.stringify(next)), [storageKey])
  return [ordered, commit] as const
}
