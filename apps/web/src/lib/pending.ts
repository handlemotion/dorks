import { useRef, useState } from 'react'
import { errorMessage } from '@dorks/client/react'

/**
 * Runs an async submit handler at most once at a time. `pending` drives `disabled`; the ref guards the window before React
 * re-renders, so a fast double-click cannot start two requests.
 */
export function usePending() {
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { run, pending, error, setError }
}
