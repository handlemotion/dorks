# Dorks Cloud: plans, teams and identity

Status: in progress. The cloud side lives in `handlemotion/dorks-cloud` (private); this page is the contract between it and
`apps/server`, and describes the server side. The relay protocol itself is in [mobile](mobile.md).

## Plans

Entitlements belong to a Better Auth **organization** (an org). Every user gets a personal org on sign-up, so a person on their own
is simply an org with one member.

| Plan | What it is |
|---|---|
| **free** | Today's Dorks: the relay to your own Mac(s), one person. You bring your own Boat and Claude. |
| **collab** | A team: members, invitations and roles (owner, admin, member), and an always-on hosted `apps/server` that Dorks runs for the org. Teammates open the same chats on it and send messages; the agent knows who sent each one. Automations, PR polling and timers run there around the clock (a Mac cannot wake at night). Priced per seat; you still bring your own Boat and Claude. |

**Cloud credit** is an add-on, not a plan: sandbox minutes on Dorks' own Boat account instead of your key, billed per minute at a
markup over Boat's price.

`GET /v1/orgs/:orgId/entitlements` (members only) answers
`{plan: "free"|"collab", seats, seatsUsed, hostedServer, cloudCredit, includedMinutes, usedMinutes, periodEnd, overage}`.

## Servers belong to orgs

A server is a Mac paired through the relay, or the hosted server of a collab org (`kind: "hosted"`). Either way it belongs to one
org (`macs.org_id`), and every member of that org sees it in `GET /v1/macs` and can reach it through the relay. Teammates always go
through the relay: there is no direct connection to a server.

A server learns its org when it pairs (`orgId` in the claimed answer of `POST /v1/pair/poll`) and again each time its link opens
(`PATCH /v1/mac`, which answers `{macId, name, orgId, kind}`), so a Mac paired before teams existed picks it up. It keeps it in
`settings.cloud_org_id`; a hosted server is started with `DORKS_ORG_ID` instead ([env](env.md)).

## Identity

The cloud signs a short-lived JWT for whoever makes a request: Better Auth's `jwt` plugin, EdDSA (Ed25519), keys published at
`<cloud>/api/auth/jwks`, 10 minutes, `iss` and `aud` both the cloud's URL (`BETTER_AUTH_URL`). Claims:

| Claim | Meaning |
|---|---|
| `sub` | The user's id |
| `name`, `email` | Who they are, for attribution and for the agent |
| `org` | The org that owns the target server (not the session's active org) |
| `role` | Their role in that org: `owner`, `admin` or `member` |
| `plan` | The org's plan: `free` or `collab` |

The relay puts it in the `x-dorks-actor` header of every request frame it sends a server ([mobile](mobile.md), "Link protocol").
`GET /api/auth/token` returns the same token for the session's active org.

## This server (`apps/server`)

`services/team.ts` decides who a request is (its **actor**), `core/jwt.ts` checks tokens, `services/presence.ts` keeps presence.

- **The local owner** holds the owner token on loopback (the desktop app, the web app, `pnpm dev`) and may do anything, as before.
- **A relayed request with `x-dorks-actor`** is a teammate. The server verifies the token itself: the signature against the cloud's
  JWKS (cached; fetched again every 10 minutes, or when a token names an unknown key id, at most every 30 s, which covers a rotation),
  `exp` and `nbf` (30 s of skew), `iss` and `aud`, and `org` against its own org. It never trusts the relay: a forged or replayed
  header from a compromised relay fails the signature or the expiry. A refused token answers 403 `forbidden`, with a message that
  says why ("This server belongs to another team").
- **A relayed request without a token** is the single-owner phone of [mobile](mobile.md), on its v1 allowlist, but only while the
  server has no org yet. Once it knows its org, every relayed request needs a token.

The relay path hands the request to the UI API with the owner token and records its actor against the `Request` object itself
(`runAs`), so no header a client sends can name an actor.

### Roles

Enforced by the server on every relayed request, whatever the relay allowed (`teamAllowed`):

| Role | May |
|---|---|
| member | Use dorks: create them, chat, queue, stop, merge their PRs, comments, files. View settings, usage, repos, builds, automations and their runs, skills, MCP servers, connected apps. Upload images. `GET /api/me`, `POST /api/presence`. |
| admin, owner | Everything a member may, plus settings writes, secret **names** (and setting or deleting a secret), automations (create, edit, delete, run now, Sentry projects), builds (every route) and skills (install, update, remove). |

Never, for any role: local access (`/api/dorks/:id/local/*`, `/api/local-access`), secure inputs (`/api/dorks/:id/inputs/*`), the
box's live desktop, MCP server definitions, sign-ins (Boat, Antigravity, the snapshot build), phone pairing, `/mcp` and the sim
routes. Secret values never leave the server, as before.

### Attribution and the agent

Everything a teammate does is stored with who did it, as `{id, name}` (the local owner, a schedule and an event store nothing):

- **Messages**: the `user_message` event carries `by`; a queued message keeps it (`queued_messages.sent_by`) until it goes out.
- **Sessions**: `dorks.created_by`, `createdBy` on the dork.
- **Automation runs**: a run started by hand carries `by` (`automation_runs.run_by`), and the session it starts is created by them.

The agent is told who wrote each teammate's message: the text it receives starts with `[Message from Ada Lovelace (ada@team.test)]`
and a blank line, so in a shared chat it can address people and knows who asked for what. The transcript keeps the message as
written, with `by` beside it.

The web app names the sender over a user bubble that is not yours (a message without `by` on a team server is the owner's), shows
the initials of whoever started a chat at the end of its sidebar row, and shows who else is looking in the chat's header.

### Presence

In memory only. A client (a tab, a phone) opens `/api/live?client=<id>` (8 to 64 letters, digits, `-` or `_`) and says which dork
it shows with `POST /api/presence {client, dorkId | null}`. It counts while its live stream is open, or for a minute after it posted
when it has none. Every live stream gets `{t: "presence", dorkId, viewers: [{id, name}]}` right after `hello` for each dork with
viewers, then whenever a dork's viewers change. The local owner shows as `{id: "owner", name: "Owner"}`. A person's client ids are
kept under their own id, so nobody can move another person's presence.

### `GET /api/me`

`{kind: "local"|"phone"|"member", id, name, email, role, org, plan, serverOrg}`: who this request is (`id` null for the local owner)
and the org the server belongs to.
