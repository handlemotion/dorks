import { useRef, useState } from 'react'
import { errorMessage } from '@dorks/client/react'

/**
 * Runs an async submit handler at most once at a time. `pending` drives `disabled`; the ref guards the window before React
 * re-renders, so a fast double-click cannot start two requests. Resolves true when it ran and succeeded.
 */
export function usePending() {
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    setPending(true)
    setError('')
    try {
      await fn()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { run, pending, error, setError }
}
