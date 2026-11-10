import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import '@fontsource-variable/inter'
import './styles.css'
import { getRouter } from './router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
)
