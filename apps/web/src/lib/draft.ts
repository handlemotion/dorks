import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

const PREFIX = 'dorks.draft.'

function read(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(PREFIX + key, value)
    else localStorage.removeItem(PREFIX + key)
  } catch {
    // Storage full or disabled: the draft still holds for as long as the app runs.
  }
}

/**
 * Each composer's text, by key, kept in localStorage so it survives leaving the page (another tab, another chat) and a reload. A store
 * of its own, not a page's state: what writes into a draft (Chat details' "Ask for…", a picked element) and what reads it (the
 * composer) share it, and a keystroke redraws only the composer, not the page and transcript around it.
 */
const drafts = new Map<string, { value: string; listeners: Set<() => void> }>()

function entry(key: string) {
  let found = drafts.get(key)
  if (!found) drafts.set(key, (found = { value: read(key), listeners: new Set() }))
  return found
}

/** The draft's text now (for a send, without subscribing to every keystroke). */
export const getDraft = (key: string) => entry(key).value

/** Sets the draft. Written here, not in a component: a send that resolves after the composer unmounted (the owner already left) must still clear the saved draft. Clearing it removes the entry. */
export function setDraft(key: string, next: SetStateAction<string>) {
  const draft = entry(key)
  const value = typeof next === 'function' ? next(draft.value) : next
  if (value === draft.value) return
  draft.value = value
  write(key, value)
  for (const listener of draft.listeners) listener()
}

/** Writes the draft without reading it: the component does not redraw as it changes. */
export function useDraftSetter(key: string): Dispatch<SetStateAction<string>> {
  return useCallback((next) => setDraft(key, next), [key])
}

/** A composer's text and its setter. */
export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const { listeners } = entry(key)
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    [key],
  )
  const text = useSyncExternalStore(subscribe, () => entry(key).value)
  return [text, useDraftSetter(key)]
}
