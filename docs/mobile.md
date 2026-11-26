# iPhone app and the cloud relay

Status: proposed (v1, TestFlight for the owner and a few friends). Teams: [cloud](cloud.md).

Dorks runs on the owner's Mac: the server, its SQLite database and its lifecycle machine live there, and the UI talks to it over
loopback ([architecture](architecture.md)). The iPhone app is a second UI for that same server. It does not get a server of its own,
and agents never connect to the phone: the phone reads and writes the Mac's UI API, through a small relay in the cloud.

```
 iPhone (apps/mobile) ──HTTPS + SSE──► dorks-cloud (Cloudflare Worker) ◄──WS, dialed by the Mac── apps/server on the Mac
   Better Auth session                  Better Auth, D1, one Durable Object per Mac                 cloud link (services/cloudLink.ts)
                                                                                                    └─ runs each request against its own UI API
```

## Decisions

- **Relay, not a hosted backend.** The Mac stays the only place state lives. The phone's requests travel to the Mac over a socket the
  Mac opens itself (like the bridge links, it dials out), so the Mac still opens no inbound port and needs no public URL. The Mac must
  be awake and running Dorks for the phone to work; sandboxes keep running in Boat either way.
- **Same API, same client.** The phone uses `@dorks/client` and `@dorks/shared` unchanged, with the relay's URL as `baseUrl` and
  its session token as `token`. `/api/live` (SSE) streams through the relay. Anything the phone shows means the same thing as on
  the desktop, by construction.
- **The Mac decides what the phone may do.** The cloud only forwards. The Mac runs each relayed request against its own UI app, but
  only when the person it is for may make it: their `x-dorks-actor` token is checked against the cloud's keys and their role
  ([cloud](cloud.md)). A compromised relay can do no more than a signed-in member could.
- **Servers belong to orgs.** A Mac pairs into an organization (the user's personal one by default); every member of it sees the
  Mac in `GET /v1/macs` and reaches it through the relay. The server Dorks runs for a Teams or Cloud org (its `orgRuntime`) is one more entry, `kind: "hosted"`. Plans,
  roles and identity: [cloud](cloud.md).
- **Separate private repository** for the cloud service (`handlemotion/dorks-cloud`): it holds accounts and deploy config, while
  this repository is public. The protocol between the Mac and the relay is specified here, so either side can change against it.
- **Sign-in starts from Wok's** (handlemotion/omni `apps/ios`), in Inter: Continue with Google, Sign in with Apple, or Continue
  with email, which pushes an email page and then a code page (six boxes, autofill, Resend after 30 s; swipe back between them). Apple stays native (`expo-apple-authentication`, Better Auth's `apple` provider with the ID token), which
  satisfies App Review guideline 4.8; Google is Better Auth's web OAuth through `ASWebAuthenticationSession` back to `dorks://`; the
  code is Better Auth's `emailOTP` plugin. `GET /v1/sign-in-methods` says which ones the relay has configured, and the app disables
  the others. The launch screen stays up until sign-in or the Macs list can draw, then fades (200 ms).
- **Pairing, not credentials.** The Mac never signs in to an account. Settings shows a short code and a QR code; the signed-in phone
  claims it, and the Mac receives a Mac token that only opens its own relay socket.

## Pairing

1. Desktop Settings, **Phone**: "Pair a phone" calls the local server's `POST /api/phone/pair`. The server calls the relay's
   `POST /v1/pair/start` with the Mac's name and answers `{code, url, expiresAt}`. The UI shows the code (`ABCD-2345`) and a QR code
   of `url` (`dorks://pair?code=ABCD2345&cloud=<origin>`). Codes last 10 minutes.
2. The phone, signed in, scans the QR code (or the code is typed) and calls `POST /v1/pair/claim {code, orgId?}`. The relay records
   a Mac in that org (without `orgId`: the session's active org, else the personal one); only an owner or admin of it may pair.
3. The server polls `POST /v1/pair/poll` every 2 s until it is claimed, receives `{macId, macToken, orgId}` once, stores the token
   encrypted in settings (`cloud_mac_token_enc`) and the org (`cloud_org_id`), and opens the link. Live: `{t: "settings"}`.
   Each time the link opens it calls `PATCH /v1/mac` (empty body) and keeps the `orgId` and `pairedBy` it answers.
4. Unpair from either side: the desktop's `DELETE /api/phone` (calls `DELETE /v1/mac`), or the phone's Macs list
   (`DELETE /v1/macs/:id`). A revoked token closes the link with 4401 and the server forgets it.

## Local server: `/api/phone`

| Method and path | Body | Result |
|---|---|---|
| `GET /api/phone` | | `{cloudUrl, paired, macId, name, link: "off"\|"connecting"\|"online"\|"offline", pairing: {code, url, expiresAt} \| null}` |
| `POST /api/phone/pair` | `{name?}` | `{code, url, expiresAt}`: starts (or restarts) pairing; `not_configured` when `DORKS_CLOUD_URL` is empty |
| `DELETE /api/phone/pair` | | `{}`: cancels a pairing in progress |
| `DELETE /api/phone` | | `{}`: unpairs this Mac and closes the link |

`DORKS_CLOUD_URL` (default the hosted relay, `https://api.dorks.build`; empty turns the feature off) is the relay's origin ([env](env.md)).

## Link protocol (WebSocket, dialed by the Mac)

`GET wss://<cloud>/v1/mac/connect` with `Authorization: Bearer <macToken>`. One socket per Mac; a newer one replaces the older
(closed with 4000). Frames are JSON text; bodies are base64.

| Direction | Frame | Meaning |
|---|---|---|
| relay → Mac | `{t: "req", id, method, path, headers, body?}` | One phone request. `path` includes the query (`access_token` stripped). `headers` carries only `content-type`, `accept` and `x-dorks-actor`: the caller's identity token ([cloud](cloud.md), "Identity") |
| relay → Mac | `{t: "cancel", id}` | The phone went away (an SSE stream closed): abort it |
| Mac → relay | `{t: "head", id, status, headers}` | Response status and `content-type` |
| Mac → relay | `{t: "chunk", id, data}` | Part of the body (any number; SSE sends one per message) |
| Mac → relay | `{t: "end", id}` | The response is complete |
| either | `{t: "ping"}` / `{t: "pong"}` | Every 25 s; a socket silent for 70 s is dropped |

- The Mac answers a request it refuses with `head` 403 and an `AppError` body (`forbidden`, with a message saying why), so the phone
  sees a normal API error.
- Limits: 64 requests in flight per Mac, request bodies up to 10 MB (image uploads), 30 s to the first `head` for anything but
  `/api/live`. The relay answers 503 `{error: {code: "offline"}}` while no Mac socket is connected.
- The Mac reconnects with backoff from 1 s to 30 s. A close with 4401 (token revoked) unpairs it.

### Relay allowlist (enforced on the Mac)

A request with `x-dorks-actor` is allowed by the member's role ([cloud](cloud.md), "Roles"). A request without one is today's
single-owner phone, refused once the server knows its org, and until then allowed only on the v1 list (everything the phone shows):

- `GET /api/live`, `GET /api/settings`, `GET /api/usage`, `GET /api/github/repos`, `GET /api/builds`, `GET /api/builds/:id`
- `/api/dorks` and everything under `/api/dorks/:id` **except** `/local/*` (running commands on the Mac), `/inputs/*`
  (secret values would cross the relay) and `/desktop`
- `POST /api/images`, `GET /api/images/:id` (served as the Mac's `/images/:id`)
- Automations: `GET /api/automations`, `GET /api/automations/:id`, `GET|POST /api/automations/:id/runs`, `PATCH /api/automations/:id` (on or off)
- Plugins: `GET /api/skills`, `POST /api/skills/resolve`, `POST /api/skills`, `POST /api/skills/:name/update`,
  `DELETE /api/skills/:name`, `GET /api/mcp-servers`, `GET /api/composio`

Never: settings writes, secrets, MCP server definitions, local access, `/mcp`, the sim routes. These stay on the Mac.

## Relay (`dorks-cloud`)

Hono on Cloudflare Workers, Better Auth on D1, one Durable Object per Mac (`MacRelay`, `idFromName(macId)`) that holds the Mac's
socket (hibernatable WebSockets) and multiplexes phone requests over it.

| Method and path | Auth | Result |
|---|---|---|
| `/api/auth/*` | | Better Auth (Apple ID token, Google OAuth, email code (`emailOTP`), `bearer`, `expo`, `organization` and `jwt` plugins) |
| `GET /api/auth/jwks` | none | The keys identity tokens are signed with (EdDSA, Ed25519) |
| `GET /api/auth/token` | session | An identity token for the session's active org |
| `/api/auth/organization/*` | session | Teams: `create`, `invite-member`, `accept-invitation` (only the invited address), `update-member-role`, `remove-member`, `leave`, `set-active`, `delete`, `list-members`. Members plus open invitations up to the plan's `memberLimit` (`403 MEMBER_LIMIT_REACHED`; a fair-use cap on Teams and Cloud) |
| `GET /v1/orgs` | session | `{id, name, slug, logo, personal, role, active, plan}[]`: my orgs |
| `GET /v1/orgs/:orgId/entitlements` | session, member | The org's plan ([cloud](cloud.md), "Plans") |
| `GET /v1/sign-in-methods` | none | `{google, apple, email}`: which sign-in methods are configured |
| `POST /v1/pair/start` | none | `{pairId, pollToken, code, expiresAt}` (rate limited per IP) |
| `POST /v1/pair/poll` | `pollToken` | `{status: "pending"}`, or once `{status: "claimed", macId, macToken, orgId}`; 404 when expired |
| `POST /v1/pair/claim` | session, owner or admin of the org | `{code, orgId?}` → `{macId, name, orgId}` |
| `GET /v1/macs` | session | `{id, name, online, lastSeenAt, kind: "mac"\|"hosted", orgId, org: {id, name, logo, personal}, role}[]`: the servers of every org I am in, personal first |
| `DELETE /v1/macs/:id` | session, admin | `{}`: revokes the Mac's token, closes its socket |
| `PATCH /v1/mac` | Mac token | `{macId, name, orgId, kind, pairedBy?: {id, name, email}}`: which org owns this server and who paired it (empty body) |
| `DELETE /v1/mac` | Mac token | `{}`: the Mac unpairs itself |
| `GET /v1/mac/connect` | Mac token | WebSocket upgrade into the Mac's `MacRelay` |
| `* /v1/macs/:id/api/*` | session, member of the Mac's org | Relayed to the Mac as `/api/*` with the caller's `x-dorks-actor`; the response streams back |

Mac tokens and poll tokens are 32 random bytes, stored as SHA-256 hashes. The phone's own bearer token never reaches the Mac; the
`x-dorks-actor` token tells it the user's id, name, email, org, role and plan. Deleting an org closes its servers' sockets with 4401.

An invitation email links `dorks://invite/<id>` (and shows the id as a code); the app accepts it with
`POST /api/auth/organization/accept-invitation {invitationId}`.

Privacy: the relay sees the traffic it forwards (TLS ends at Cloudflare) but stores none of it: no request or response body is
logged or kept. End-to-end encryption with a key exchanged in the QR code is the follow-up once the shape settles.

## iPhone app (`apps/mobile`)

Expo SDK 58, Expo Router, iOS 26+ look (Liquid Glass through native components), following the phone's light or dark setting.

- **Shell**: a top-left glass menu button slides the whole app to the right and reveals the sidebar underneath (a pan from the left
  edge does the same): New chat, the chat list (the desktop sidebar's sessions), and links to Chat, Customize and Settings.
- **Tabs**: a compact bar of three icons at the centre: **Chat**, **Plugins** (skills, MCP servers, connected apps) and **Automations** (on or off, run now, the last run). Builds comes later.
- **Chat**: the empty state greets ("Good morning", "What are we tackling today?") above the composer. The composer is glass with
  `+` (photo library, attaches images through `POST /api/images`), the text, and send; under it the repository, model (any of
  `settings.claudeModels`, effort included) and build (any of `/api/builds`) as native menus. A thread is the desktop's: the same
  folded blocks (`fold` from `@dorks/shared`), final answers shown and turns folded behind "Worked for 2m 14s", queued messages,
  Stop while it works, model and build switchable per chat.
- **Pull requests**: the session's open PRs are pills above the composer (`#201` with its state). A pill opens the PR as a native
  sheet: title, branches, checks, changed files with stats, and **Slide to merge** (the merge method the repository prefers;
  `Merge stack` for a stacked PR), pinned to the head SHA shown.
- **Customize**: skills (install from a source, update, remove), MCP servers and connected apps (read only for v1).
- **Settings**: the paired Macs (online or not, unpair), pair another Mac (scan), sign out.
- **Native first**: tabs, sheets, menus, context menus, the camera scanner and haptics are native components (`@expo/ui`,
  `expo-glass-effect`, `expo-symbols`); React Native views only where no native one exists (the transcript, the composer).

### Updates and releases

- EAS Build with `development`, `preview` (internal) and `production` (TestFlight) profiles; `eas submit` sends production
  builds to TestFlight.
- EAS Update: `expo-updates` with a channel per profile and `runtimeVersion: {policy: "fingerprint"}`, so JS-only changes ship as
  updates and a native change makes a new build.
- The app is not part of the desktop release (changesets); it versions on its own.

## Desktop: Dorks Cloud

The desktop (and the web UI) works in Dorks Cloud **organizations** ([dorks-cloud](https://github.com/handlemotion/dorks-cloud), teams):
every account has a personal org, made at sign-up, and can create or join others to share chats with friends or colleagues. Every
server belongs to one org: a member's Mac (normally in its owner's personal org) or, on Dorks Teams and Dorks Cloud, the server Dorks runs for the org (`orgRuntime`).

- **Sign-in** is the phone's email code (Better Auth `emailOTP`), started from Settings, **Dorks Cloud**, or the sidebar switcher's
  *Sign in to Dorks Cloud*. The local server holds the session, encrypted in settings (`cloud_session_enc`), and never hands it to the
  UI. Pairing a phone is unchanged and separate: the Mac token only opens this Mac's own relay socket.
- **The switcher** (the sidebar's top row) lists orgs only: the personal org first (your name), the others with their logo and plan, then
  *Create organization* (Better Auth `organization/create`). Machines are never entries in it.
- **Which server an org means** is resolved inside the org (`apps/web/src/lib/place.ts`): the server Dorks runs for it (`kind: "hosted"`) when it has one,
  through the relay; else this Mac when it may (the personal org, or a team this Mac belongs to), with *Connect to* another of the org's Macs as a
  small row under the switcher when there are several; else the org's one online Mac; else the org asks which Mac to connect to (or
  says nothing runs it yet). The choice is remembered per browser.
- **Reaching another server**: the UI keeps the owner token of its own server and calls `/api/cloud/servers/:id/api/*` there; the server
  forwards it to the relay's `/v1/macs/:id/api/*` with the session and streams the answer back (`/api/live` included). Shared images
  load from `/cloud/servers/:id/images/:imageId`, outside `/api` like `/images/:id` (the image id is the capability). The relay and
  the server reached decide what the request may do (the relay allowlist, and the `x-dorks-actor` identity the relay adds).
- **Settings on another server** follow your role there (`GET /api/me` through the relay, [cloud](cloud.md) "Roles"): an admin or owner
  edits what the server allows over the relay (AI accounts, Boat, Sessions, Shared variables, Sentry); a member sees those pages read
  only; the setup checklist and the snapshot build are read only for everyone; what never crosses the relay (GitHub sign-in, Your
  computer, Phone, Antigravity's sign-in) is left out. Appearance and Dorks Cloud are this app's and always editable
  (`apps/web/src/components/settings/access.tsx`).
- **Teams**: Settings › Organization manages the org you work in now: its members and roles, invitations (admins), name and logo
  (owners), leave, delete (owners, never the personal org). A plan is one price per org; a fair-use cap limits its members
  (`MEMBER_LIMIT_REACHED`). Invitations to you show under *Invitations* in the switcher and in Settings › Account; the email's
  `dorks://invite/<id>` opens `#/invite/<id>` (the desktop shell does not register the `dorks://` scheme yet; until then the code
  from the email goes in Settings › Account).
- **The GitHub owner filter** lives in the archived sessions list (Show archived on New session): it narrows that list to one GitHub
  user or organization. The sidebar and the new session's repository picker are not filtered by owner.

| Method and path (local server) | Body | Result |
|---|---|---|
| `GET /api/cloud` | | `{cloudUrl, user: {id, name, email, image} \| null}` |
| `POST /api/cloud/sign-in/email` | `{email}` | `{}`: the relay emails a six-digit code |
| `POST /api/cloud/sign-in/verify` | `{email, code}` | `{cloudUrl, user}`: signed in, the session stored encrypted |
| `DELETE /api/cloud/session` | | `{}`: signed out (here and, best effort, on the relay) |
| `GET /api/cloud/places` | | `{orgs: {id, name, slug, logo, personal, plan, role, active, servers: {id, name, kind, online, lastSeenAt}[]}[]}`, personal first (the relay's `GET /v1/orgs`; an older relay's `/v1/macs` grouped by org); `not_configured` when signed out or the session ended |
| `POST /api/cloud/orgs` | `{name}` | the new org, owned by the account |
| `GET\|POST /api/cloud/auth/organization/:action` | Better Auth's | team management as the signed-in account: `get-full-organization`, `list-user-invitations`, `get-invitation`, `invite-member`, `cancel-invitation`, `accept-invitation`, `reject-invitation`, `update-member-role`, `remove-member`, `leave`, `update`, `delete` (nothing else); a refusal is an AppError (`limit` for `MEMBER_LIMIT_REACHED`) |
| `* /api/cloud/servers/:id/api/*` | any | that server's UI API through the relay |
| `GET /cloud/servers/:id/images/:imageId` | | that server's shared image (no owner token) |

`pnpm dev:mock` has the same routes with a fake account (any email, any six digits; `MOCK_CLOUD=1` starts signed in), three orgs and
one in-memory mock server per remote server, so switching visibly changes the chats.

## Dorks Cloud

Plans (Dorks Local, Dorks Teams, Dorks Cloud), teams and roles, identity tokens and what a team server does
with them: [cloud](cloud.md). The server Dorks runs for a Teams or Cloud org is the same `apps/server`, dialing the relay like a Mac;
the phone cannot tell them apart beyond `kind`.

## Not in v1

Builds tab, push notifications (turn finished, PR ready: the relay can send them through Expo push once the Mac reports them),
answering secure inputs and local-access requests from the phone, the right-hand Chat details panel (artifacts, computer, changes),
end-to-end encryption, Android.
