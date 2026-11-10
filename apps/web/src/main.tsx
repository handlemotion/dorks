import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import '@fontsource-variable/inter'
import './styles.css'
import { ThemeSync } from './components/ThemeSync'
import { getRouter } from './router'

// When the desktop shell makes the window natively translucent (it sets `vibrancy: true` in window.__DORKS__), the page paints no
// backdrop of its own; in a browser, or a window without vibrancy, a soft gradient stands in.
if (window.__DORKS__?.vibrancy) document.documentElement.dataset.vibrancy = ''

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Follows the system appearance; `.dark` on <html> is what the shadcn tokens key off. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ThemeSync />
      <RouterProvider router={getRouter()} />
    </ThemeProvider>
  </StrictMode>,
)
