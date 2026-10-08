# Convex spike: go / no-go

Branch `spike/convex` (cut from `dorks/foundation`; nothing committed). Cloudflare code in `apps/api` is untouched and its tests still pass.

## Verdict: **GO**, with three things to fix before migrating

All acceptance items passed against a real Convex backend (self-hosted image, same engine as cloud; see "What was not tested").
The client-side replay/ticket/WebSocket code disappears entirely, and the lifecycle machine, normalizer, crypto and bridge protocol carry over nearly untouched.
It is **not** a big LOC win on the server (about a wash), the win is operational: no Durable Object, no D1 mirror, no alarm multiplexer, no ticketed sockets, one data store.

Fix before migrating: (1) DB bandwidth is the limit that binds, not function calls (see usage); (2) pin `better-auth` to 1.6.x in the Convex app; (3) the bridge needs a heartbeat because Convex has no connection-close signal.

## Acceptance results (`apps/convex/scripts/*`, 37 backend checks + 6 web + 5 Expo-screen, all pass)

| Criterion | Result |
|---|---|
| Foreign email can't get a code or create an account | 403 on send and on sign-in for `eve@evil.com`, `a@jaantonio.com.evil.com`, `a@evil.com@jaantonio.com`, `@jaantonio.com`; no mail captured; auth `user` table holds only `@jaantonio.com`. Create-hook alone also blocks: with the send guard disabled, the code mailed but sign-in 403'd and no user row was created. |
| create -> ready -> live turn -> idle -> sleep -> wake same session | passes; `claudeSessionId` identical after wake; bridge `bseq` numbering continues from `afterBridgeSeq` |
| archive pauses, unarchive doesn't wake, message to archived rejected | passes; the rejected message leaves no event and no outbox row (the mutation throws, so it rolls back) |
| Kill/reopen client mid-turn: no gaps/dupes, no replay code | passes: reopened client's first snapshot already contained what was stored while it was gone, final view byte-identical to the always-on client, every snapshot dense `1..n`. Same on real web page (hard reload mid-stream, headless Chrome) |
| No secrets in tables/logs/query results | passes: scanned a full table export (including the auth component's tables), `convex logs`, host log and backend container logs for Claude token, CLI secret, GitHub token, bridge secret, encryption key, auth secret. Also asserted on every query result any client or the bridge ever received. Secrets exist only as AES-GCM ciphertext (`userSettings`, `userSecrets`) |
| Usage estimate | below |

## What worked

- **Auth: `@convex-dev/better-auth` 0.12.5 + emailOTP works cleanly; no need for `@convex-dev/auth`.** Same `hooks.before` + `databaseHooks.user.create.before` code as `apps/api/src/auth.ts` ported verbatim. Resend via `fetch` from the HTTP action (awaited; no `waitUntil`). Expo works with `expo()` server plugin (native-style request, `expo-origin` header and no `Origin`, verified at HTTP level) and web with `crossDomain`.
- **Reactive paginated events**: one query (`events.list`, 19 lines), newest-first, consumed with `usePaginatedQuery` + the existing pure `fold`. Shared hook `useDorkEvents` is used by both web and Expo.
- **Lifecycle**: `machine.ts` unchanged, `machine.test.ts` unchanged and green (plain node, no workerd). The driver is `lib/dispatch.ts` (132 lines): persist state, append status event, then effects. Effects are DB writes and `scheduler.runAfter` calls **in the same transaction**, so "state persisted before effects" is now atomic instead of a convention. Timers = scheduled functions with ids in `dorkRuntime.timers` (replaces `timers.ts` + `alarm()`).
- **Secrets path**: the reactive `bridge.commands` query returns only markers (`fetch_configure`, `fetch_gh_token`); the bridge calls `bridge.configure` / `bridge.ghToken` **actions** which decrypt and return the secrets directly. Better than the DO design, where secrets sat in a socket frame built from D1 reads.
- **Bridge secret** is `HMAC(BRIDGE_SECRET_KEY, dorkId)`: nothing stored, retried `create_box` hands out the same value, constant-time verify.
- **Atomic rollback** removes the old "persist then check archived" ordering concerns.

## What failed or hurt (ordered by importance)

1. **DB bandwidth is the binding quota.** Each delta batch re-runs `events.list` per subscriber and re-reads the page. Measured: 30s streaming turn = 152 pushes/client, avg 3.9KB/push. Mitigation already in: consecutive deltas for one message grow a single row (tail coalescing) instead of one row per delta. Further levers: page size 40 -> 20, 300ms batching, or a separate small "live text" doc.
2. **Version pin**: the component's peer range is `better-auth >=1.6.11 <1.7.0`; your `apps/api` is 1.7.7. Works with 1.6.33 pinned (pnpm keeps both copies side by side, `apps/api` keeps 1.7.7), `@better-auth/expo` must be pinned to the same 1.6.33. Moving to Convex means you stay a minor behind on better-auth until the component catches up. No functional gap found in 1.6.33 for emailOTP.
3. **No connection lifecycle.** `bridge_lost` was a WebSocket close. Replaced by 30s `heartbeat` mutation + a `bridge_watch` timer (about 40 lines). Costs about 120 calls per awake hour per dork.
4. **Typing friction**: `_generated/api` pulls server sources into the web/iOS typecheck, so the carried-over files (`crypto.ts`, `github.ts` read global `Env`; `normalize.ts` has an unused var) leaked errors into web tsconfig (`noUnusedParameters` relaxed, `types/env.d.ts` included). Fix on migration: move the carried files into `convex/lib` or a package with one tsconfig. Also `ConvexBetterAuthProvider`'s `authClient` type does not unify with a client that has `emailOTPClient()`; cast needed (works at runtime).
5. **Expected errors are logged as `Uncaught ConvexError`** in function logs (archived, not_found): log noise, no data leak.
6. Normalizer is stateful; mutations aren't. Solved without editing `normalize.ts` by seeding it with a synthetic `message_start` from `dorkRuntime.streamMsgId`. Works, a little clever; moving the id into the event stream would be cleaner.
7. `expo-secure-store` has no web implementation and browsers hide `Set-Cookie` from `fetch`; Expo-web uses the web (`crossDomain`) client. Native path (`expoClient`) is verified only at HTTP level.

## Usage estimate (2 users)

Facts (convex.dev/pricing, docs "limits"): Free/Starter include 1M function calls, 0.5GB DB, **1GB DB bandwidth**, 1GB data egress, 20 GB-h actions; function calls explicitly include **subscription updates**. Starter = same quotas, pay-as-you-go ($2.20/1M calls, $0.22/GB DB I/O, $0.132/GB egress).

Measured per streaming turn (30s of text, generous): ~175 push mutations, 152 subscription pushes per viewing client, ~40 lifecycle/heartbeat/timer calls.

Assumptions: 2 users x 20 turns/day x 22 days = 880 turns/month.

| | Function calls/mo | DB bandwidth/mo | Egress/mo |
|---|---|---|---|
| 1 viewer per turn | 880 x ~370 = **~330k** | ~0.5 GB | ~0.5 GB |
| web + iOS both watching | 880 x ~520 = **~460k** | ~1.0 GB | ~1.0 GB |
| 3x heavier use, both watching | ~1.4M | ~3 GB | ~3 GB |

**Free is enough on function calls (3x headroom). Bandwidth sits right at the 1GB line when both clients watch every turn.** Overage is cents (3x scenario about $3), so: start on Free, expect to flip to Starter (card on file, ~$0-5/mo). Storage/action compute are negligible. Not a measured production number; the 30s-of-streaming turn is a sim.

## LOC (non-blank, non-comment)

| | LOC |
|---|---|
| Retired server code (`dork.ts` 463, `app.ts` 103, `auth.ts` 45, `timers.ts` 27, `mailer.ts` 29, `deps.ts` 84, `index.ts` 3) | 754 |
| Retired D1 migrations | 50 |
| Retired client replay (`shared/client/stream.ts`) | 95 |
| **Removed total** | **~900** (plus 556 test LOC: `dork.test`, `dorks-api.test`, `auth.test`, `helpers`, replaced by the 3 e2e scripts) |
| Added Convex server (`apps/convex/convex/*`, no sim) | 836 (incl. 56 for `settings.ts`, which the API didn't have yet) |
| Added dev-only (`simbox.ts` 33, `convex-sim.mjs` 104, `host.mjs` 24) | 161 |
| Added client (`client/index.ts` 16, web 129, Expo 143) | 288 |

Net server: roughly flat (about 780 added without settings vs about 850 retired). Hidden win: the removed code is the hard concurrency/replay/ticket logic; the added code is mostly straight CRUD plus the dispatch driver.

## Migration plan

Carry over (move, don't rewrite):
- `apps/api/src/lifecycle/machine.ts` + `test/machine.test.ts` (as-is)
- `apps/api/src/normalize.ts` + test
- `apps/api/src/lib/crypto.ts`, `github.ts` + tests (drop the `Env` global: take the key as an argument)
- `apps/api/src/lib/box.ts` (`BoxProvider`; `SimBox` stays for unit tests; real Upstash provider plugs into `convex/lib/box.ts`)
- `apps/api/src/lib/domain.ts`
- `packages/shared`: `events.ts`, `client/fold.ts` (+ test), `bridge.ts` (plus the additive `commandFrame` schema)
- `apps/api/src/lib/mailer.ts` logic -> `convex/mail.ts` (done)

Retired: `src/dork.ts`, `src/app.ts` routes (`/api/dorks*`, `/api/me`, `stream-ticket`, bridge WS route), `src/lib/timers.ts`, `src/lifecycle/deps.ts` (summary mirror, `missingOnboarding`), `src/auth.ts` (replaced by `convex/auth.ts`), `migrations/0001*, 0002*` (replaced by `schema.ts`), `shared/client/stream.ts`, `wrangler` DO/D1 config, `dork.test.ts`, `dorks-api.test.ts`, `auth.test.ts`, `helpers.ts`, `apply-migrations.ts`.

Order: (1) move carried files into a shared package, fix typing leak; (2) real Upstash `BoxProvider` + real bridge using `convex-sim.mjs` as the reference; (3) GitHub webhook as a Convex `httpAction` calling `dorks.reportPr` (`verifyWebhook` carries over); (4) push-token table + Expo push in an action; (5) deploy to Convex cloud, set env (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `BRIDGE_SECRET_KEY`, `RESEND_API_KEY`, `SITE_URL`, ...); (6) switch web/iOS fully, then delete `apps/api`. Open decisions: web hosting stays on Workers (only the data layer moves); decide page size/batching against the bandwidth numbers once real turns exist.

## What was not tested

- **Convex Cloud itself**: ran the official self-hosted backend in Docker (the local-dev binary needs a newer glibc than this sandbox). Same engine, but no real quota metering; usage numbers above are measured pushes/bytes x a model.
- **Live Resend**: no API key. Requests hit a local mock that enforces the same `Authorization`/JSON shape as the old mailer. First real send is the one thing left to verify.
- **iOS device/simulator**: no macOS. The Expo screen was run through react-native-web in headless Chrome (same components, same Convex RN client, same hook); `expoClient` native auth verified only at HTTP level (`expo-origin`, no `Origin`).
- **Real Upstash Box / real Claude stream**: sim bridge only. Real turns have tool runs and idle gaps, so streaming volume is probably lower than assumed.
- **Bridge-lost watchdog path** end to end (needs 90s + 3min waits; covered by machine unit tests only).
- Convex's own limits under concurrent writers (OCC retries on a hot dork were not stress-tested).

## Bridge `push` contract (lifecycle correctness pass)

`bridge.push({ dorkId, secret, frames })` returns `{ ok: true }` or `{ ok: false, expectedBseq: number }`.

- Events must be numbered exactly `bridgeSeq + 1`, `+ 2`, ... Anything `<= bridgeSeq` is a replay and is skipped.
- The whole call is validated before any of it is applied. If it contains a gap, **nothing in it is applied** (no events, no `ack`/`ready`/`agent_exited`/`flushed`) and `expectedBseq` is `bridgeSeq + 1`: the next event the backend will take. The bridge must resend everything from its event `expectedBseq` on, plus any control frames it had in that call. Because nothing was applied, no frame is ever applied twice. (Liveness still counts: the call refreshes the heartbeat.)
- A bridge must never drop a batch: retry with capped backoff, and keep events until a call returns `{ ok: true }`.
- Limits, rejected with a `ConvexError` whose `data.code` is `too_many_frames` (more than 500 frames per call) or `event_too_large` (an event's `raw` over 256KB serialized). The whole call is rejected and nothing from it is stored, so a bridge must not retry the same payload. On `too_many_frames` split the batch. On `event_too_large` replace that event's `raw` with a small stub such as `{ type: "truncated", truncated: true }` and **keep its bseq** (the backend ignores unknown event types), so the numbering stays gapless.
- `flushed` should carry `id`: the cid of the `flush` command it answers (the same id the bridge acks). It is optional for compatibility; without it a stale `flushed` from a cancelled pause can end a later flush early.
- While a pause is under way (the box call is in flight, or cancelled but still landing) `bridge.commands` withholds `user_message` frames, so a message is never acked by a box that is about to go down. They are delivered after the next `ready`.
- Older bridges that ignore the return value keep working; they just cannot recover from a gap.

## Run it

```sh
docker run -d --name convex-local --network host -v convex-data:/convex/data -e INSTANCE_NAME=dorks-spike -e INSTANCE_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') -e CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210 -e CONVEX_SITE_ORIGIN=http://127.0.0.1:3211 -e DO_NOT_REQUIRE_SSL=1 ghcr.io/get-convex/convex-backend:latest
# put CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY (docker exec convex-local ./generate_admin_key.sh) in apps/convex/.env.local
cd apps/convex && npx convex env set ...   # see list in the verdict section; BOX_PROVIDER=sim, RESEND_API_URL=http://127.0.0.1:8899/emails
pnpm test                 # machine/normalize/crypto/github suites, unchanged files
./scripts/run-e2e.sh      # backend acceptance + secret scan
node scripts/web-e2e.mjs  # needs `vite dev` on :3000 and the sim host
node scripts/ios-web-e2e.mjs  # needs `expo start --web` on :8081
node scripts/usage.mjs    # usage measurement
```
