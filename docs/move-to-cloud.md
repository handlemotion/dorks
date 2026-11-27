# Move to cloud

A paid workspace (Dorks Teams or Dorks Cloud) runs on the cloud runtime (handlemotion/dorks-cloud `docs/org-runtime.md`), never on a
Mac. Dorks Local (free) is the personal workspace on the owner's Mac. What a Mac holds moves to the cloud in one of two ways:

- **Take-over**: a paid org this Mac still serves (a team paired before it paid, or the personal workspace once it upgrades) moves as
  a whole. The app starts it on its own the first time an owner or admin opens that org on this Mac (`apps/web/src/components/AutoMove.tsx`);
  Settings › Organization › Where it runs › **Move to cloud** retries it. A team's Mac then leaves the org; the personal workspace keeps
  its Mac. Either way the Mac keeps a paused local copy, and the relay lists the org with `runtime: "cloud"`, which the app follows
  (`runsOnWorker`, `apps/web/src/lib/place.ts`).
- **Copy into a team**: from the free personal workspace, Settings › Organization › **Move to a team** copies everything into a paid team
  the account owns or administers, also one that already runs in the cloud. Names the team already has (shared variables, MCP servers,
  skills) are kept as they are there. The personal workspace stays on this Mac; the moved sessions are archived here (the flag only:
  their sandboxes are the cloud's to resume).

The Mac's owner starts either; the cloud checks that their account is an owner or admin of the target org.

What moves: sessions with their transcripts and images, **builds** (definition and variables; the image is rebuilt in the cloud for a
build the owner had approved), automations (on their builds), MCP servers, skills, shared variables and settings. A **local** session
([local dorks](local-dorks.md)) moves without its worktree: in the cloud its next message starts a sandbox from the pushed branch, so work
that was never committed and pushed stays on the Mac.

## What the Mac does (`apps/server/src/services/cloudMove.ts`)

1. Refuses while a session is working (`409 conflict`), then **freezes** the Mac (`lifecycle/freeze.ts`): until the move ends,
   no message, notification or automation run may start or wake a session (`409`, its transaction rolled back), so nothing lands
   on the Mac only after it was copied. Pauses every idle session (`sleep_due`) and waits until all are asleep.
2. `POST /v1/orgs/:orgId/imports` → an import id and the key secrets are sealed to.
3. `PUT …/manifest`, every session's events in parts (each at most `maxPartBytes` of UTF-8 JSON), every chat image, then
   `POST …/commit`. Every phase is recorded in `meta.cloud_move`. A commit whose answer is lost, or a restart mid-commit
   (`recoverMove` at startup), is reconciled with `GET …/imports/:id` before anything is retried: `committed` finishes the move,
   `open` retries the commit.
4. Turns its own automations off (the cloud runs them now), records the move as done and unfreezes.

`GET /api/cloud/move` is the progress the app polls; `POST /api/cloud/move {orgId}` starts it; `POST /api/cloud/export {importId, key}`
returns the whole export as one file (the same builder), for support and for checking a move by hand. All three are the local
owner's only: a teammate reaching this server through the relay gets `403`.

## The format (`packages/shared/src/cloudExport.ts`)

Zod schemas in `@dorks/shared`, which the cloud imports to validate the same way: `exportManifest` (everything but transcripts),
`exportEventsPart` (one upload of events), `exportFile` (manifest + `events` by session id + `imageData` by image id; checks every session's
events are exactly `1..lastSeq` and every image has its bytes). `format: "dorks-export"`, `version: 1`.

| Part | Contents | Not included |
|---|---|---|
| `sessions` | each dork's row: title, repo, branch, provider, mode, model, effort, state (`sleeping`), archived, `boxId` and `claudeSessionId` (Teams resumes the same box), parent, creator, timestamps, `events: {count, lastSeq}` | timers, bridge cursors, pending commands |
| events | `{seq, ts, body}`: the append-only `events` rows, `body` a `ClientEventBody` | |
| `automations` | the spec (triggers, instructions, model, effort, mode, enabled) | run history |
| `mcpServers` | name, transport, redacted url, command, args, header and env names; `secrets` sealed `{headers, env, url}`; `oauth: true` when it must be signed in again | OAuth tokens |
| `skills` | source and the stored folder (gzipped JSON, base64) with its digest | |
| `variables` | shared variables, each value sealed | |
| `images` | the chats' images (`dorks-image:<id>` in transcripts): id (kept, transcripts name it), session, mime, size; the bytes are uploaded on their own | attachments never claimed by a message |
| `builds` | each build's name, machine size, setup script, repos, services, `approved` (the owner approved this spec), `hadImage`, and its variables (`secret`, `buildTime`, the value sealed as `build-var\|<build>\|<name>`, null when nobody filled it in); `defaultBuildId` | the image (a snapshot in this Mac's Boat account), runs, drafts |
| `settings` | sleep minutes, comment policy, Code Mode default, Boat org and environment, Sentry org and URL; `reenter`: which of `claudeToken`, `boatKey`, `sentryToken`, `antigravityToken`, `github` the Mac had, for the cloud to ask again | the credentials themselves |

**Sealing.** No secret travels in clear. The import's key is ECDH P-256 (`alg: "ECDH-ES+HKDF-SHA256+A256GCM"`). The Mac makes one
ephemeral key pair per export (`sealing.epk`), derives an AES-256-GCM key with HKDF-SHA256 (salt = import id, info
`dorks-import-v1`) and seals each value with a random IV and additional data `dorks-import-v1|<orgId>|<importId>|<what>`, where
`what` is `variable|<name>` or `mcp|<name>`. A sealed value cannot be replayed into another org, import or name. The cloud opens
them with `openImportSealed(privateJwk, manifest)` and stores them as org secrets; the private key never leaves it and can be
dropped after the commit.

## The import API (dorks-cloud builds it)

Better Auth session (`authorization: Bearer <session>`), the caller an `owner` or `admin` of the org (else `403`). Errors are
`{code, message}`.

| Call | Body | Answer |
|---|---|---|
| `POST /v1/orgs/:orgId/imports` | `importCreate`: `{format, version, source: {kind: "mac", macId}, counts: {sessions, events}}` | `201 importCreated`: `{importId, key: {kid, alg, jwk}, maxPartBytes, expiresAt}`. A plan other than `teams`/`cloud`: `403`. From `source.macId`: a **take-over** when the Mac is a server of the org, a **copy** when it is the caller's own Mac in their personal workspace and the org is another; any other Mac `403 forbidden`. An org that already runs in the cloud takes more imports (they merge) |
| `PUT …/imports/:id/manifest` | `exportManifest` (its `orgId`, `importId` must match) | `200`; may be sent again until the commit |
| `PUT …/imports/:id/sessions/:sessionId/events` | `exportEventsPart`: `{events}` (≤ `maxPartBytes`, ≤ 5000) | `200 {expectedSeq}`. Seqs already stored are skipped; a gap is `409 {code: "conflict", expectedSeq}` and the Mac resumes there. A part over `maxPartBytes`: `413` |
| `PUT …/imports/:id/images/:imageId` | `exportImageData`: `{mime, data}` (base64), for an image the manifest lists | `200`; served afterwards at the org's image URL under the same id |
| `GET …/imports/:id` | | `{status: "open" \| "committed", sessions: {<id>: {nextSeq}}}` |
| `POST …/imports/:id/commit` | `{}` | `200 importCommitted`: `{runtime: "cloud", kind: "takeover" \| "copy", sessions, events, builds, automations, mcpServers, skills, variables, images, skipped: [{what, name, why}], reenter, macRemoved}`, after it checked every session has `count` events, opened the secrets and wrote the org (D1 rows, s2 `events` streams in seq order, org secrets, builds with their variables re-sealed and approved images rebuilt, automations with fresh schedules). Names the org already has (variables, MCP servers, skills) stay and come back in `skipped`. A team taken over loses its Mac (`macRemoved: true`); the personal workspace keeps it, and a copy leaves the Mac where it is. `GET /v1/orgs` then lists the org with `runtime: "cloud"` and the app runs it on the Worker. `409 {missing: [{sessionId, nextSeq}], missingImages}` if events or images are missing. Must be idempotent in effect: a commit retried after a lost answer finds the import `committed` (`GET`) |

An import that is never committed changes nothing and expires (`expiresAt`). The reference implementation, in memory, is
`apps/server/test/fixtures/cloudImport.ts` (the server tests run the move against it).
