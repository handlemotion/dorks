import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { setWindowTheme } from '../lib/desktop'

/**
 * Publishes the theme the app is actually showing: `data-theme="light|dark"` on <html> (for anything that keys off it besides
 * `.dark`), and to the desktop shell so the native material matches. Renders nothing.
 */
export function ThemeSync() {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
    setWindowTheme(resolvedTheme)
  }, [resolvedTheme])
  return null
}
