# Environment variables

Two kinds of variables exist, and they live in different places:

- **Convex deployment variables.** The backend functions read these from the *deployment*, not from your shell. `pnpm dev:backend` (and `pnpm dev:convex`) copy them from the repo-root `.env` to the local deployment with `apps/convex/scripts/sync-env.mjs`, which finds the names by scanning `apps/convex/convex` for `process.env.NAME`.
- **Web build variables** (`VITE_*`). Read by Vite at build time and shipped to the browser, so never put a secret behind that prefix.

`pnpm env:init` writes a `.env` with freshly generated secrets (mode 600; it never overwrites an existing file). `.env` is git-ignored. Do not paste its values into issues, logs or commits.

## Convex deployment

| Name | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | Signs sessions. Random hex. |
| `SITE_URL` | yes | Web origin that is allowed to sign in (for example `http://localhost:3000`). |
| `ENCRYPTION_KEY` | yes | Base64, 32 bytes. Encrypts stored tokens and CLI secrets (AES-GCM). |
| `BRIDGE_SECRET_KEY` | yes | Random hex. The per-dork bridge secret is `HMAC(BRIDGE_SECRET_KEY, dorkId)`. |
| `RESEND_API_KEY` | yes (until sign-in changes) | Mails sign-in codes. Any placeholder works with `RESEND_API_URL` pointed at the local mail catcher. |
| `RESEND_API_URL` | dev | Override for the Resend endpoint; `pnpm dev:backend` points it at `pnpm dev:mail`. |
| `DORKS_OWNER_EMAIL` | for Boat | The only email allowed to sign in when `BOX_PROVIDER` is `boat`. |
| `BOX_PROVIDER` | no | `boat` (default) or `sim` (local simulator, tests). |
| `BOAT_API_KEY` | for Boat | Boat API key. See [Boat sandboxes](boat.md). |
| `BOAT_ORG` | no | Boat organization id to pin billing to one wallet. |
| `BASE_SNAPSHOT_ID` | for Boat | Name or id of the base snapshot ([infra/snapshot](../infra/snapshot/README.md)). |
| `SIM_HOST_KEY` | with `sim` | Shared key between the backend and `infra/bridge-sim/host.mjs`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | for GitHub | The GitHub App used for PR autonomy ([GitHub App](github-app.md)). |
| `EXTRA_TRUSTED_ORIGINS` | no | Extra comma-separated origins allowed to sign in. |
| `OTP_SEND_PER_EMAIL`, `OTP_SEND_PER_IP`, `OTP_SEND_GLOBAL`, `OTP_WINDOW_MS` | no | Sign-in code rate limits ([Auth](auth.md)). |

Built into Convex and never set by hand: `CONVEX_CLOUD_URL`, `CONVEX_SITE_URL`.

## Web

| Name | Purpose |
|---|---|
| `VITE_DORKS_SERVER` | Optional. Prefills the server address on the browser connect screen. The server address and owner token are not build settings: the desktop app injects them, or you type them once ([apps/web](../apps/web/README.md)). |

## Adding a variable

Read it by its exact name in code, add a row here and its name to the relevant `.env.example`. This list is a work in progress while the project moves to a local-first, single-owner setup.
