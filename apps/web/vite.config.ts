import { defineConfig, lazyPlugins } from 'vite-plus'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// A static single-page app: `vp build` writes ./dist/client (where apps/desktop's prepare:ui looks), which the desktop shell (or any static host) serves. Relative asset
// URLs and hash-based routing (see src/router.tsx) mean it works from any path or custom scheme with no server rewrite rules.
// lazyPlugins: `vp lint` / `vp fmt` / `vp check` read this config too, and must not load the plugins to do so.
const mockPort = process.env.MOCK_PORT
const mockToken = process.env.MOCK_TOKEN ?? 'mock-owner-token'

export default defineConfig({
  base: './',
  build: { outDir: 'dist/client', emptyOutDir: true },
  resolve: { tsconfigPaths: true },
  // ES module workers can split: the diff worker (components/DiffWorkers.tsx) then loads each Shiki grammar on demand instead of inlining all of them.
  worker: { format: 'es' },
  server: mockPort
    ? {
        proxy: {
          '/api': { target: `http://127.0.0.1:${mockPort}`, changeOrigin: true },
          // Shared images (attachments, screenshots) are served outside /api.
          '/images': { target: `http://127.0.0.1:${mockPort}`, changeOrigin: true },
          // Another Dorks Cloud server's images, through the mock (mock-cloud.ts).
          '/cloud': { target: `http://127.0.0.1:${mockPort}`, changeOrigin: true },
        },
      }
    : undefined,
  plugins: lazyPlugins(() => [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    tailwindcss(),
    viteReact(),
    ...(mockPort
      ? [
          {
            name: 'dorks-mock-runtime',
            apply: 'serve' as const,
            transformIndexHtml(html: string) {
              const boot = `<script>window.__DORKS__={apiUrl:location.origin,ownerToken:${JSON.stringify(mockToken)}};</script>`
              return html.replace('</head>', `${boot}</head>`)
            },
          },
        ]
      : []),
  ]),
})
