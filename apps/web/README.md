# @dorks/web

The Dorks UI: a static React single-page app (Vite, TanStack Router with hash routing, Tailwind, `@dorks/ui`). It talks to a local `dorks-server` through [`@dorks/client`](../../packages/client) (loopback HTTP plus the `/api/live` event stream). There is no server-side rendering and no backend of its own.

## How it finds the server

In order:

1. **The desktop app.** The Tauri shell sets `window.__DORKS__ = { apiUrl, ownerToken, ... }` before the page loads ([docs/desktop.md](../../docs/desktop.md)). It also provides native commands the UI uses: reading the `gh` CLI token (with a consent dialog), keeping the Mac awake while sessions work, and setting the public URL.
2. **A browser.** The first screen asks for the server address and owner token and keeps them in `localStorage`. In `vp dev` only, `?server=<url>&token=<token>` skips that screen.

The server must allow the page's origin (`DORKS_UI_ORIGINS`; `http://localhost:3000` and the Tauri origin are allowed by default).

## Develop

```sh
pnpm --filter @dorks/web dev:mock   # web on :3000 + an in-memory mock server on :4747 (MOCK_CONFIGURED=1 skips setup)
pnpm --filter @dorks/web dev        # web only; point it at a real server from the connect screen
pnpm --filter @dorks/web build      # static output in dist/client (what apps/desktop packages)
pnpm --filter @dorks/web test       # unit tests
```

`dev:mock` prints the one URL to open. The mock implements the API contract in [docs/architecture.md](../../docs/architecture.md) with a scripted fake agent, so the whole flow (setup, sessions, streaming, settings) works with no Boat account.

## Layout

- `src/routes/_conn.tsx` the owner-token gate; everything that talks to the server lives under it.
  - `setup.tsx` first-run guide (Boat key, base snapshot, agent sign-in, GitHub token).
  - `_app/dorks.tsx`, `_app/settings.tsx` the app with the sidebar.
- `src/components/SettingsForms.tsx` one form per setting group, shared by setup and settings.
- `src/lib/desktop.ts` the desktop shell contract; `src/lib/connection.ts` server discovery.
- `src/routes/dev.*` development-only showcases that need no server.
