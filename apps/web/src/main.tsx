import { StrictMode, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { Toaster } from '@dorks/ui/sonner'
import { ThemeSync } from './components/ThemeSync'
import { getRouter } from './router'
import { TooltipProvider } from '@dorks/ui/tooltip'

// The page is opaque (--app), even when the desktop shell gives the window a native material: nothing shows through.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Follows the system appearance; `.dark` on <html> is what the shadcn tokens key off. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ThemeSync />
      {/* Validation and failures across the app: one toast stack, top center. */}
      <Toaster position="top-center" closeButton style={{ '--width': '340px' } as CSSProperties} />
      {/* Names of icon-only actions (components/Tip.tsx): after a short rest, then instant while moving between them. */}
      <TooltipProvider delay={400}>
        <RouterProvider router={getRouter()} />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
