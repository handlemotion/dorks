import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

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
    // Storage full or disabled: the draft still holds while the composer is mounted.
  }
}

/** A composer's text, kept in localStorage under `key` so it survives leaving the page (another tab, another chat) and a reload. Clearing it removes the entry. */
export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [text, setState] = useState(() => read(key))
  // Written here, not in a state updater: a send that resolves after the composer unmounted (the owner already left) must still clear the saved draft.
  const latest = useRef(text)
  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      const value = typeof next === 'function' ? next(latest.current) : next
      latest.current = value
      write(key, value)
      setState(value)
    },
    [key],
  )
  return [text, setText]
}
