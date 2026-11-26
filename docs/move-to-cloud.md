# Move to cloud

A team org (Dorks Teams or Dorks Cloud) that runs on its owner's Mac can move to the cloud runtime (handlemotion/dorks-cloud
`docs/org-runtime.md`, phase 9). Settings › Organization › Where it runs › **Move to cloud**: the Mac's owner starts it; the cloud
checks that their account is an owner or admin of the org. The Mac then leaves the org and keeps a paused local copy.

## What the Mac does (`apps/server/src/services/cloudMove.ts`)

1. Refuses while a session is working (`409 conflict`); pauses every idle one (`sleep_due`) and waits until all are asleep, so no
   transcript grows while it is copied.
2. `POST /v1/orgs/:orgId/imports` → an import id and the key secrets are sealed to.
3. `PUT …/manifest`, then every session's events in parts, then `POST …/commit`.
4. Turns its own automations off (the cloud runs them now) and records the move (`meta.cloud_move`).

`GET /api/cloud/move` is the progress the app polls; `POST /api/cloud/move {orgId}` starts it; `POST /api/cloud/export {importId, key}`
returns the whole export as one file (the same builder), for support and for checking a move by hand. All three are the local
owner's only: a teammate reaching this server through the relay gets `403`.

## The format (`packages/shared/src/cloudExport.ts`)

Zod schemas in `@dorks/shared`, which the cloud imports to validate the same way: `exportManifest` (everything but transcripts),
`exportEventsPart` (one upload of events), `exportFile` (manifest + `events` by session id; checks every session's events are
exactly `1..lastSeq`). `format: "dorks-export"`, `version: 1`.

| Part | Contents | Not included |
|---|---|---|
| `sessions` | each dork's row: title, repo, branch, provider, mode, model, effort, state (`sleeping`), archived, `boxId` and `claudeSessionId` (Teams resumes the same box), parent, creator, timestamps, `events: {count, lastSeq}` | timers, bridge cursors, pending commands |
| events | `{seq, ts, body}`: the append-only `events` rows, `body` a `ClientEventBody` | |
| `automations` | the spec (triggers, instructions, model, effort, mode, enabled) | run history |
| `mcpServers` | name, transport, redacted url, command, args, header and env names; `secrets` sealed `{headers, env, url}`; `oauth: true` when it must be signed in again | OAuth tokens |
| `skills` | source and the stored folder (gzipped JSON, base64) with its digest | |
| `variables` | shared variables, each value sealed | |
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
| `POST /v1/orgs/:orgId/imports` | `importCreate`: `{format, version, source: {kind: "mac", macId}, counts: {sessions, events}}` | `201 importCreated`: `{importId, key: {kid, alg, jwk}, maxPartBytes, expiresAt}`. `409` if the org already runs in the cloud. A plan other than `teams`/`cloud`: `403` |
| `PUT …/imports/:id/manifest` | `exportManifest` (its `orgId`, `importId` must match) | `200`; may be sent again until the commit |
| `PUT …/imports/:id/sessions/:sessionId/events` | `exportEventsPart`: `{events}` (≤ `maxPartBytes`, ≤ 5000) | `200 {expectedSeq}`. Seqs already stored are skipped; a gap is `409 {code: "conflict", expectedSeq}` and the Mac resumes there |
| `GET …/imports/:id` | | `{status: "open" \| "committed", sessions: {<id>: {nextSeq}}}` |
| `POST …/imports/:id/commit` | `{}` | `200 importCommitted`: `{runtime: "cloud", sessions, events}`, after it checked every session has `count` events, opened the secrets, wrote the org (D1 rows, s2 `events` streams in seq order, org secrets, automations with fresh schedules) and **removed the Mac from the org's servers**: with no Mac left, `GET /v1/orgs` lists it without one and the app runs it on the Worker. `409 {missing: [{sessionId, nextSeq}]}` if events are missing |

An import that is never committed changes nothing and expires (`expiresAt`). The reference implementation, in memory, is
`apps/server/test/fixtures/cloudImport.ts` (the server tests run the move against it).
