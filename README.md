# dorks

pnpm workspace. `pnpm install`, then:

- `pnpm dev` — Convex + web; `pnpm dev:convex`, `pnpm dev:web`, `pnpm dev:ios` individually
- `pnpm dev:web` — TanStack Start on Workers via Vite (:3000)
- `cd apps/ios && pnpm start` — Expo
- `pnpm typecheck`

Secrets live in Doppler (project `dorks`); see [docs/secrets/README.md](docs/secrets/README.md). With `DOPPLER_TOKEN` set (Conductor workspaces have it), `pnpm dev` starts Convex + web with the `dev` config (`pnpm dev:ios` for Expo).

## Full local loop (Docker + Doppler)

```sh
bash cloud-setup.sh     # any machine: Doppler CLI, pnpm, dependencies (needs DOPPLER_TOKEN); add --backend to also start Convex
pnpm dev:backend        # self-hosted Convex in Docker + deploy + Doppler dev env (idempotent; rerun after backend changes)
pnpm dev:mail           # prints sign-in codes (the backend's RESEND_API_URL points here); REAL_MAIL=1 pnpm dev:backend uses Resend
pnpm dev:web            # web on :3000
```

Or all of it detached in one command: `pnpm dev:up` (status `pnpm dev:status`, stop `pnpm dev:down`, logs in `/tmp/dorks-dev`; see AGENTS.md, "Running servers").

Boxes are simulated (`BOX_PROVIDER=sim`): `pnpm dev:sim` runs the sim host (`BRIDGE_IMPL=real pnpm dev:sim` for the real `dorks-bridge` with the fake Claude CLI; add `CLAUDE_BIN=claude` for the real one, which refuses to run as root). A real Claude needs a token in Doppler `dev` as `E2E_CLAUDE_TOKEN` (see the inventory).

### Running the real agent locally

Needs `E2E_CLAUDE_TOKEN` in Doppler `dev` (a `claude setup-token` value). The Claude CLI refuses `--permission-mode bypassPermissions` as root, so on a root-only VM run the sim host as an unprivileged user (`ubuntu` here), with a writable `HOME`, a writable `infra/bridge/dist`, `DORKS_E2E_ROOT` set to a directory it owns, and the proxy/CA variables if the VM needs them:

```sh
doppler run -p dorks -c dev -- setpriv --reuid=1000 --regid=1000 --init-groups env -i PATH="$PATH" HOME=/tmp/u-home DORKS_E2E_ROOT=/tmp/u-e2e \
  CONVEX_URL=http://127.0.0.1:3210 SIM_HOST_KEY="$SIM_HOST_KEY" BRIDGE_SECRET_KEY="$BRIDGE_SECRET_KEY" BRIDGE_IMPL=real CLAUDE_BIN="$(command -v claude)" \
  node infra/bridge-sim/host.mjs
```

Bridge-level check without Convex: `CLAUDE_CODE_OAUTH_TOKEN=$E2E_CLAUDE_TOKEN pnpm --filter @dorks/bridge test live`, run as that same user. `apps/convex/scripts/e2e.mjs` has one timing check ("mid-turn") that only holds for the simulator's slow streaming; with the real CLI treat it as a smoke test.

## Sign-in

Sign-in is open to any email address. Use the web origin (:3000) so Better Auth's origin check passes. Codes are emailed through Resend (`RESEND_API_KEY`); for local dev without Resend, point Convex at the mock (`RESEND_API_URL`, `apps/convex/scripts/mock-resend.mjs`).

## Tests

`pnpm test` runs the Convex suite (lifecycle machine, normalizer, crypto, GitHub, functions via `convex-test`), the bridge suite and the shared client suite.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It uses no real secrets: every key is generated per run.

- **checks**: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r --if-present test`.
- **backend-e2e**: starts a self-hosted Convex backend (`ghcr.io/get-convex/convex-backend`, pinned by digest) with `--network host`, deploys `apps/convex` with `npx convex dev --once`, sets throwaway Convex env vars, then runs `apps/convex/scripts/run-e2e.sh` (acceptance + secret scan) and `apps/convex/scripts/web-e2e.mjs` (headless Chrome against `apps/web` dev). On failure the logs and screenshots in `/tmp/dorks-e2e` are uploaded as the `dorks-e2e-logs` artifact (the raw table export is not).

Reproduce locally by following the steps in the workflow; `CHROME_PATH` overrides the Chrome binary used by `web-e2e.mjs`.

Keep CI in step with the backend as other branches land:

- Any new required Convex env var (the GitHub App and Upstash settings, say) must be added to the `set_env` list in the "Deploy functions and set throwaway env" step, using throwaway or sim values only.
- Rate limits keyed by IP or email can trip the e2e, which sends many sign-in codes from `127.0.0.1` within seconds. If the auth work adds env-configurable caps, set CI-specific overrides in the same step.
- A new workspace package (such as `infra/bridge`) is picked up by `pnpm -r` once it is in `pnpm-workspace.yaml`; commit its lockfile changes or `--frozen-lockfile` fails.
