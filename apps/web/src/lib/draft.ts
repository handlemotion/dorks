import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

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
  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (next) =>
      setState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next
        write(key, value)
        return value
      }),
    [key],
  )
  return [text, setText]
}
