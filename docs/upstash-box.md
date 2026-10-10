# Upstash Box provider: research and design

Implementation: `apps/convex/convex/lib/upstash.ts` (selected in `convex/lib/box.ts` with `BOX_PROVIDER=upstash`). Tests: `apps/convex/test/upstash.test.ts`, `test/boxGone.test.ts`.

Researched 2026-10-07 from the public docs and the official SDK source. **No real box, snapshot or credential was used.** Everything below marked UNKNOWN has not been observed on a live account; the exact manual test is given for each, and they are collected in the checklist at the end.

## Sources

Docs (Markdown versions, index at <https://upstash.com/docs/llms.txt>):

- Box Basics / lifecycle: <https://upstash.com/docs/box/overall/how-it-works>
- Quickstart (init command): <https://upstash.com/docs/box/overall/quickstart>
- Keep Alive: <https://upstash.com/docs/box/overall/keep-alive>
- Snapshots: <https://upstash.com/docs/box/overall/snapshots>
- Network Policy: <https://upstash.com/docs/box/overall/network-policy>
- Security & Secrets (env vars): <https://upstash.com/docs/box/overall/security>
- Pricing & Limits: <https://upstash.com/docs/box/overall/pricing> and <https://upstash.com/pricing/box>
- Shell (`exec`): <https://upstash.com/docs/box/overall/shell>

**The REST API has no published reference.** The wire format below is read from the official TypeScript SDK, `@upstash/box` 0.7.9 (<https://github.com/upstash/box>, `dist/client.js` and `dist/types.d.ts`), which is MIT licensed and is the only complete description of the endpoints. Treat it as "documented by implementation": it can change, which is why all of it lives in one file.

## REST API as implemented

Base URL `https://us-east-1.box.upstash.com` (override: `UPSTASH_BOX_BASE_URL`). Auth header `X-Box-Api-Key: <UPSTASH_BOX_API_KEY>`. JSON bodies. Error body shape `{ "error": "<message>" }`.

| Operation | Call | Notes |
|---|---|---|
| Restore (create) | `POST /v2/box/from-snapshot` `{ snapshot_id, name, labels[], init_command, env_vars{}, network_policy?, size?, keep_alive? }` | Returns `BoxData`; `status: "creating"` until ready. Poll `GET /v2/box/{id}` (SDK: every 2s, up to 300s). |
| Status | `GET /v2/box/{id}` or `GET /v2/box/{id}/status` | `status` is one of `creating, idle, running, paused, error, deleted`. |
| List by label | `GET /v2/box?label=<label>` | Returns `BoxData[]` (the SDK types it as a bare array). |
| Pause | `POST /v2/box/{id}/pause` | SDK refuses for keep-alive boxes ("Keep-alive boxes cannot be paused"). |
| Resume | `POST /v2/box/{id}/resume` | The SDK does not poll after it. |
| Delete | `DELETE /v2/box/{id}` | Permanent. The bulk `DELETE /v2/box {ids}` and `?all=true` snapshot variants exist; the provider never uses them. |
| Init command | `GET/PUT/DELETE /v2/box/{id}/startup` `{ init_command }` | Works on paused boxes too (applied on next resume). |
| Exec | `POST /v2/box/{id}/exec` `{ command: ["sh","-c",...], folder? }` returns `{ exit_code, output, error? }` | Runs to completion (synchronous). |
| Network policy | create body `network_policy`, or `PUT /v2/box/{id}/config/network-policy` | Snake_case on the wire: `{ mode, allowed_domains, allowed_cidrs, denied_cidrs }`. |
| Labels | create body `labels`, `POST /v2/box/{id}/config/labels {label}`, `DELETE .../labels/{label}` | Limit: **5 labels, each ≤ 20 chars of `[A-Za-z0-9._:-]`** (SDK `types.d.ts`, `BoxConfig.labels`). |
| Snapshot | `POST /v2/box/{id}/snapshots {name}`, `GET .../snapshots`, `DELETE .../snapshots/{id}` | Async; poll the list until `status: "ready"`. Customer images ([snapshots.md](snapshots.md)) use these, and the account-wide `DELETE /v2/box/snapshots {ids}` (explicit ids only) to delete one without needing its box. Restoring a missing snapshot id answers `404 {"error":"Snapshot not found"}` (checked 2026-10-10). |
| Upload a file | `POST /v2/box/{id}/files/upload` multipart (`paths`, `files`) | Use **absolute** paths (`/tmp/x`); the file is owned by the box user, mode 0644 (chmod it afterwards for secrets). A relative path lands somewhere not findable. |

**Error codes: not documented anywhere.** The SDK only distinguishes "response not OK" and reads `error` from the body; the only status codes mentioned in the docs are `400` once the free-plan LLM budget is exhausted (pricing page). The provider therefore classifies by:

- `401`/`403` → auth error (`UpstashBoxError`, message names `UPSTASH_BOX_API_KEY`, never the key).
- `404` / `410` → `BoxNotFoundError`, but only **after confirmation** (below). Body text is never used: a 5xx gateway page or a 400 saying "runtime image not found" is just an HTTP error, not a missing box.
- `429` → rate limited.
- anything else → `upstash <op>: HTTP <status>`.

Response bodies of failed calls are discarded unread; they never reach an error message, a log line or an event (a provider error can echo the request, which contains `BRIDGE_SECRET`). The API key is only ever in the request header. **"Gone" is confirmed, not assumed.** After a 404 on resume/pause/delete the provider does `GET /v2/box/{id}`; only if that is also 404 *and* the API otherwise answers (`GET /v2/box?label=dorks-probe` succeeds) is the box declared gone. If the list endpoint 404s too, it is reported as a configuration error naming `UPSTASH_BOX_BASE_URL` (a mistyped base URL or a renamed route would otherwise look like "every box vanished", clear every `boxId`, and make delete silently succeed and leak boxes). A 404 on the POST while the box exists is an error, not "gone".

UNKNOWN: the exact status the API returns for pause-on-paused / resume-on-running (409? 400? 200?). The provider does not depend on it: on any non-auth failure it reads the box status and accepts the call if the box is already in the target state (tested with a fake that refuses both).

Env vars: `env_vars` at create. Blocked names: `PATH, HOME, LD_PRELOAD, LD_LIBRARY_PATH, NODE_OPTIONS` ([security](https://upstash.com/docs/box/overall/security)); ours (`DORK_ID`, `BRIDGE_URL`, `BRIDGE_SECRET`) are fine. They are visible to every process in the box, including the agent; `BRIDGE_SECRET` is per-dork and derived (`HMAC(BRIDGE_SECRET_KEY, dorkId)`), so it only authorizes that dork's bridge calls. Real secrets (Claude token, GitHub token) still arrive via `bridge.configure`, not env.

## (a) Does pause keep processes and memory? Is the init command re-run on resume?

**Filesystem: kept. Processes and memory: not kept (documented as stopped). Init command: re-run on every container start, including resume.**

- "While a box is paused, it releases its compute resources but preserves the filesystem and environment." ([lifecycle](https://upstash.com/docs/box/overall/how-it-works#3-paused))
- "Standard boxes automatically freeze after inactivity. Storage is preserved, but **running processes are stopped** until the next request. When a new request comes in, the box wakes up automatically." ([pricing FAQ](https://upstash.com/docs/box/overall/pricing))
- "Resuming reruns the box's init command, so a server started that way comes back with the box." ([how-it-works, Pause or resume](https://upstash.com/docs/box/overall/how-it-works#pause-or-resume)) and "It runs once per container start, on create, on resume, and after a snapshot restore" ([quickstart](https://upstash.com/docs/box/overall/quickstart#init-command)).

Consequences for dorks:

1. After every resume the bridge is a **new process**; it must reconnect and the machine's `agent_ready` path handles that (`boxResumed` also enqueues `configure`). In-flight Claude state in memory is gone; only the on-disk session (`claudeSessionId`) survives. This matches how the lifecycle already treats `sleeping → waking`.
2. A box can **auto-pause on its own** after an idle timeout ("Free plans auto-pause sooner than paid plans"), independent of our `sleep` timer. The idle timeout value is not documented. See UNKNOWN A1.
3. "Paused" is not a hard stop of our concern: a request to the box (or its public URL) can wake it. We never expose ports, so only our API calls do.

UNKNOWN A1: **does the bridge's outbound connection (Convex WebSocket + 30s heartbeat) count as activity?** The docs say idle means "no active commands" / no CPU. If a mostly-idle bridge does not count, the platform may pause a box mid-session (e.g. while the user reads output), killing the bridge; the 90s stale-heartbeat watch then drives `bridge_lost → error`, and the next message resumes. Test: on a throwaway box, start the bridge (or `node -e 'setInterval(()=>fetch("https://<x>.convex.cloud/version"),30000)'` in the background), wait 30 minutes with no API calls, `GET /v2/box/{id}` and compare `status` / `last_activity_at`.

UNKNOWN A2: whether the init command's stdout/exit matter (is a crashed init command restarted? does a long-running init command block "ready"?). Test: set `init_command` to `sleep 600`, create, and time `status: creating → idle`; then `pkill sleep` and see whether it restarts.

UNKNOWN A3: does the init command run with `env_vars` in its environment? The docs say env vars are "available to all code running inside the box"; the init command is not named. Test: `init_command: "env > /tmp/init-env.txt"`, then read the file via `exec`.

## (b) Does `init_command` need keep-alive or a paid plan? Alternative start.

**No keep-alive needed. The docs contradict themselves in one sentence, and the contradiction is resolved in favour of "any box".**

- Keep Alive page: "A keep-alive box can run an init command", immediately followed by "**Init commands are not a keep-alive feature. Every box can have one**, and get, set, and delete work on any box, including a paused one." ([keep-alive](https://upstash.com/docs/box/overall/keep-alive#init-command)).
- The quickstart example creates a plain `Box.create({ runtime: "node", initCommand })` with no `keepAlive` ([quickstart](https://upstash.com/docs/box/overall/quickstart#init-command)), and `PUT /v2/box/{id}/startup` is documented for "any box including a paused one".
- The belief that it is keep-alive-only comes from an older SDK doc comment (`// keep-alive boxes only`); the current docs say otherwise.
- Keep-alive itself is **incompatible with pause/resume** ("Pause / resume: Not supported") and is billed as a fixed $8–32/box/month, so it would defeat the sleep/wake design. We do not use it.
- A snapshot restore **does not inherit** the snapshot's init command ([snapshots](https://upstash.com/docs/box/overall/snapshots#restore-from-a-snapshot), quickstart). The provider passes `init_command` on every `from-snapshot` call.

Plan gating: the pricing page lists no init-command restriction on Free, and gates only keep-alive to Pay-as-you-go/Fixed. UNKNOWN B1: whether the **Free** plan accepts `init_command` on `from-snapshot`. Test: one `POST /v2/box/from-snapshot` with `init_command: "touch /tmp/ran"` from a free account, then `exec cat`/`ls /tmp/ran`; also pause → resume and check the file's mtime changed (confirms (a)).

**Fallback if B1 fails or A2/A3 misbehave: start the bridge with `exec`.** `UPSTASH_BOX_START_MODE=exec` makes the provider omit `init_command` and instead, after create and after every resume, call `POST /v2/box/{id}/exec` with a detached, pidfile-guarded start (`execStartScript` in `upstash.ts`):

```sh
if [ -f /tmp/dorks-start.pid ] && kill -0 "$(cat /tmp/dorks-start.pid)" 2>/dev/null; then exit 0; fi
nohup setsid sh -c 'dorks-bridge' >/tmp/dorks-start.log 2>&1 & echo $! > /tmp/dorks-start.pid
```

(Shown simplified; the real script also requires `/proc/$pid/cmdline` of the recorded pid to contain the command, because the pidfile survives a pause but PIDs restart and an unrelated process could otherwise be mistaken for the bridge. It is exercised against a real `sh` in the unit tests.) The guard makes it safe to call on an already-running bridge (resume is idempotent), and it is also run when `createFromSnapshot` finds its box again by label, so a crash between create and the first start is repaired by the retry.

After `resume` the provider **polls `GET /v2/box/{id}` until the box is `running`/`idle` (60s cap) before it execs**, because the SDK does not wait after resume (UNKNOWN B3 below). `exec` is synchronous (`{exit_code, output}`), so the child must be fully detached (`nohup setsid`, redirected stdio).

UNKNOWN B3: **can an exec sent right after `POST .../resume` reach a box that is not running yet?** The SDK's `resume()` does not poll. The provider waits for the status itself, but it is unverified whether `idle`/`running` is reported only once exec works. Test: loop `resume` → immediate `exec echo ok` on a paused box 20 times with and without the status wait, and count failures.

B2 CONFIRMED 2026-10-10 on a live box: a child started with `nohup setsid ... &` by one `exec` call is still running, and writes its result file, after that call returned (snapshot builds rely on it). Whether it inherits `env_vars` was not checked. Original question: **do detached children survive the exec call returning** (the platform might kill the process group when the exec session ends), and do they inherit `env_vars`? Test: `exec` the script with `dorks-bridge` replaced by `sleep 300`, then a second `exec` of `pgrep -a sleep; env | grep DORK_ID`. If children do not survive, exec mode is not viable and `init_command` (or a paid plan) is the only way; use `exec/session` (live sessions) only as a last resort.

Exec mode costs one extra HTTP call per create/resume and, unlike init mode, leaves a gap where the box is up but the bridge is not (the watchdog covers it).

## (c) How long are paused boxes retained?

**UNKNOWN: no retention period is documented.** The only statements are qualitative: "a box auto-pauses when idle and can be resumed **days or even weeks later**" ([how-it-works](https://upstash.com/docs/box/overall/how-it-works)) and "continue days or even weeks later with perfect resumability" ([quickstart](https://upstash.com/docs/box/overall/quickstart)). Related facts:

- Storage is billed at $0.10/GB-month and "includes all data on disk, including snapshots"; a paused box costs storage but no CPU ([pricing](https://upstash.com/docs/box/overall/pricing)).
- Only *ephemeral* boxes have a TTL (default and max 3 days) ([ephemeral](https://upstash.com/docs/box/overall/ephemeral-box)); regular boxes have no documented expiry.
- Free plan: 10 concurrent boxes. UNKNOWN whether paused boxes count toward that limit; if they do, a free account caps us at 10 dorks.
- Snapshots are independent of the box and persist after the box is deleted ([snapshots](https://upstash.com/docs/box/overall/snapshots)).

We must therefore treat "box gone" as a normal event. That is the H3 path: if `resume` finds the box missing (a confirmed 404/410, see above), `boxes.resume` calls `lifecycle.boxGone`, which clears `dork.boxId`, appends "The sandbox no longer exists; it will be recreated on your next message", and the machine's `error` + `!hasBox` takes `create_box` on the next user message. **The new box starts from the base snapshot: uncommitted workspace changes and the on-disk Claude session are lost** (anything pushed to the branch survives). The same mutation (`lifecycle.boxGone`) also clears `claudeSessionId`, since that session lived on the lost box's disk and the bridge would otherwise `--resume` a session that does not exist. It is gated on the stored `boxId` equalling the one that failed, so a stale resume can never clear a newer box, and it clears the id, appends the error and dispatches `op_failed` in one transaction.

Test for C1: create a throwaway box, pause it, and `GET /v2/box/{id}` at +1 day, +7 days, +14 days, +30 days (record `status`, `last_activity_at`); resume at each point. Also ask Upstash support for the policy in writing. Test for C2: on a free account create 11 boxes, pause 1 and see whether the 11th create succeeds.

## (d) Idempotent create

Names are display-only (the SDK's `Box.getByName` is just `GET /v2/box/{nameOrId}`, and nothing documents uniqueness), so the name cannot be the idempotency key. The key is a **label** plus a list-by-label lookup before creating. `createFromSnapshot(snapshotId, { name })`:

1. `label = "d:" + hex(SHA-256(CONVEX_CLOUD_URL + "\n" + name)).slice(0, 18)`. The deployment URL is part of the hash so that dev and prod sharing one Upstash account (e.g. dev seeded from a prod export, which can keep document ids) never adopt, or sweep up errored, boxes belonging to the other. **Changing this scope later orphans existing boxes, so fix it before the first real deploy.** The provider refuses to run without it. The obvious `dork:<dorkId>` is 37 chars and **violates the 20-char label limit**; 18 hex chars is 72 bits of hash, so collisions are not a practical concern. `name` is still sent as the box's display name (so the console shows the dork id).
2. `GET /v2/box?label=<label>`. Results are re-filtered client-side (`labels.includes(label)`, `status !== "deleted"`) so an over-broad filter can never make us act on someone else's box.
3. Found a live box → return it, never create. If it is `creating`, wait until ready. If it is `paused` (we crashed after create, then the platform auto-paused it) → resume it, because nothing else would. If it is in `error` → delete it and fall through to create a fresh one.
4. Not found → `POST /v2/box/from-snapshot` with `labels: [label]` (labels are set atomically with creation, so there is no window where the box exists unlabelled), the env and `init_command`. Wait for `creating → idle` (wall-clock deadline of 240s, since each poll may itself take up to 30s and the Convex action limit is 10 minutes); if it fails to become ready, delete it (best effort) so a retry starts clean.
5. Re-list by label. If two creators raced (both saw an empty list), the **oldest `created_at`, then smallest id, wins** and the loser deletes its own box and returns the winner's id. Both sides compute the same winner without coordinating. In practice the Convex action is at-most-once per effect, so this is a belt-and-braces guard.

Remaining gap: if the process dies between step 4's POST returning and the caller recording `boxId` (`lifecycle.boxCreated`), the retry takes step 3 and adopts the box. If the dork is deleted in that window `boxes.create` already deletes the orphan. UNKNOWN D1: the list endpoint's consistency (does a box show in `GET /v2/box?label=` immediately after create returns?). Test: create via the API and list in a tight loop; if there is lag, add a short delay before the step-5 re-list. UNKNOWN D2: whether `GET /v2/box` paginates or caps the result size (irrelevant with a per-dork label, which matches at most a few boxes).

`resume` / `pause` / `delete` idempotency (all tested):

- `resume`: POST; on non-auth failure read status; `running`/`idle` counts as success; `deleted` or 404 → `BoxNotFoundError` (→ H3). A paused box resumed twice is fine.
- `pause`: POST; on failure read status; `paused`/`deleted` or a 404 → success.
- `delete`: single-box `DELETE /v2/box/{id}`; 404 → success. Ids are validated against `^[A-Za-z0-9_-]{1,128}$` before they are put in a path, so a bad id can never turn into the bulk endpoint or a different resource.

## (e) Network policy for Convex, GitHub, Anthropic, npm

Documented modes: `allow-all` (default), `deny-all`, `custom` with `allowedDomains` (exact or `*.suffix`), `allowedCidrs`, `deniedCidrs`. Applies at create and on `from-snapshot`, and is changeable on a running box. Private IP ranges are always blocked ([network-policy](https://upstash.com/docs/box/overall/network-policy)).

```jsonc
// wire format (POST /v2/box/from-snapshot body field)
"network_policy": {
  "mode": "custom",
  "allowed_domains": [
    "*.convex.cloud",                                    // bridge websocket + actions (<deployment>.convex.cloud)
    "github.com", "*.github.com", "*.githubusercontent.com", // git clone/push over https, API, raw/codeload
    "api.anthropic.com", "*.anthropic.com",              // Claude Code
    "registry.npmjs.org"                                 // npm install
  ]
}
```

This is `DORKS_NETWORK_POLICY` in `upstash.ts`; enable it with `UPSTASH_BOX_NETWORK_POLICY=dorks` (**off by default** until the tests below pass, because a wrong allow-list breaks every turn).

Notes: the docs' own example lists `github.com` *and* `*.github.com`, which suggests a wildcard does not match the apex, so both are listed; `api.github.com` is covered by `*.github.com`. `objects.githubusercontent.com`/`codeload.github.com` are covered by `*.githubusercontent.com`/`*.github.com`. Convex needs only `*.convex.cloud` (the bridge uses `CONVEX_CLOUD_URL`; HTTP actions at `*.convex.site` are not used by the bridge). Add `*.convex.site` if that changes.

UNKNOWN E1: whether `*.convex.cloud` matches and whether it applies to **WebSockets** (the doc says HTTP/DNS; "raw TCP" is mentioned only for the default open policy). Test: create a box with this policy and run `exec`: `curl -sS https://<deployment>.convex.cloud/version`, `curl -sS https://api.anthropic.com` (expect a 404/401 body, not a timeout), `curl -sSI https://github.com`, `curl -sS https://registry.npmjs.org/-/ping`, and a negative control `curl -m 5 https://example.com` (must fail). Then run the real bridge and confirm the Convex subscription connects.

UNKNOWN E2: extra hosts Claude Code touches. Known candidates: `statsig.anthropic.com`, `console.anthropic.com` (covered by `*.anthropic.com`), and Sentry error reporting (`*.ingest.sentry.io`, not allowed; set `DISABLE_ERROR_REPORTING=1`/`DISABLE_TELEMETRY=1` in the snapshot). Test: run one real turn with the policy on and `exec` `ss -tnp`/Claude Code's debug output for blocked hosts.

A tighter option for later: allowlist the exact deployment hostname instead of `*.convex.cloud`, so a compromised agent cannot reach other tenants' Convex deployments. Also remember egress control is not secrecy: the agent can still send anything it can read to an allowed host (e.g. a GitHub gist with the user's token).

## Provider configuration

| Convex env var | Meaning |
|---|---|
| `BOX_PROVIDER=upstash` | Select this provider (`sim` stays the dev default). |
| *(no platform key)* | **Bring your own key:** each user adds their own Upstash Box API key (`settings.setUpstashKey`, stored encrypted) and their boxes run in their account, on their bill. A user without a key gets "box provider not configured". `UPSTASH_BOX_API_KEY` is no longer read by the backend (only the e2e scripts use one from Doppler `dev` as a stand-in for a customer key). |
| `CONVEX_CLOUD_URL` | Set by Convex itself; used as the box-label scope (see (d)). |
| `BASE_SNAPSHOT_ID` | Only for non-Upstash providers. With Upstash the image is per user (`userSettings.workstationSnapshotId`, built in their account by `workstation.provision`); a snapshot id from another account is useless, so it is never used as a fallback. See [`infra/snapshot/README.md`](../infra/snapshot/README.md) for building one by hand. |
| `UPSTASH_BOX_START_MODE` | `init` (default) or `exec` (fallback, see (b)). |
| `UPSTASH_BOX_NETWORK_POLICY` | `dorks` to apply the allow-list above. Unset = allow-all. |
| `UPSTASH_BOX_BASE_URL` | Override the API host (other region, tests). |

## Manual test checklist (all UNKNOWNs)

Run these once against a throwaway account (Free plan first), with a throwaway snapshot, then delete everything. Cost is a few cents of CPU.

| # | Question | Test |
|---|---|---|
| A1 | Does an idle bridge connection prevent auto-pause? | Background heartbeat loop in a box, 30 min idle, read `status`. |
| A2 | Init command crash/long-run semantics | `init_command: "sleep 600"`; time to `idle`; kill and watch. |
| A3 | Init command env | `init_command: "env > /tmp/init-env.txt"`; read via exec. |
| B1 | Free plan accepts `init_command` on `from-snapshot` | See (b). Also the paused→resume re-run (mtime of `/tmp/ran`). |
| B2 | Detached exec children survive; inherit env | See (b). |
| B3 | Exec right after resume reaches a running box | Loop resume → immediate exec, with/without the status wait; count failures. |
| C1 | Paused-box retention | Pause, query at +1/7/14/30 days; ask Upstash. |
| C2 | Do paused boxes count toward the Free 10-box cap? | Create 11, pause 1. |
| D1 | List-by-label consistency right after create | Create + tight list loop. |
| E1 | `*.convex.cloud` wildcard and WebSocket under custom policy | See (e). |
| E2 | Claude Code's extra hosts | One real turn with policy on. |
| F1 | Status codes for pause-on-paused, resume-on-running, delete-missing, bad key | `curl -i` each; the provider tolerates any of them, but record them. |
| F2 | Does `from-snapshot` carry `env_vars`, `labels`, `name`, `init_command`, `network_policy` as the SDK sends them? | One create, then `GET /v2/box/{id}` and `GET /v2/box/{id}/startup`. |
