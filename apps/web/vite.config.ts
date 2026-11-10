import { defineConfig } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// A static single-page app: `vite build` writes ./dist/client (where apps/desktop's prepare:ui looks), which the desktop shell (or any static host) serves. Relative asset
// URLs and hash-based routing (see src/router.tsx) mean it works from any path or custom scheme with no server rewrite rules.
export default defineConfig({
  base: './',
  build: { outDir: 'dist/client', emptyOutDir: true },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), tailwindcss(), viteReact()],
})
