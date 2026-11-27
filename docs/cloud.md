# Dorks Cloud: plans, teams and identity

Status: in progress. The cloud side lives in `handlemotion/dorks-cloud` (private); this page is the contract between it and
`apps/server`, and describes the server side. The relay protocol itself is in [mobile](mobile.md).

## Plans

Entitlements belong to a Better Auth **organization** (an org). Every user gets a personal org on sign-up, so a person on their own
is simply an org with one member.

| Plan (id) | Price | What it is |
|---|---|---|
| **Dorks Free** (`local`) | Free, no subscription | Your personal workspace on your own Mac(s), one person. Chats run **locally only**, on the Mac (no sandboxes: a sandbox driven by a Mac stops with it), and you reach them from your phone through the relay while the Mac is on. You bring your own Claude or ChatGPT. To run in the cloud, upgrade it or move it into a team ([move to cloud](move-to-cloud.md)). |
| **Dorks Teams** (`teams`) | $5/month per org | The org runs on the dorks-cloud Worker (`orgRuntime`): shared chats in real time (teammates open the same chats and send messages, and the agent knows who sent each one) and automations around the clock, where a Mac cannot wake at night. Members, invitations and roles (owner, admin, member). You bring your own Boat key and Claude. |
| **Dorks Cloud** (`cloud`) | $29/month per org | Dorks Teams plus `cloudCredit`: Boat sandboxes on Dorks' own Boat account instead of your own key. |

**Free is the plan, Local is the place.** "Local" names where a chat runs (on a Mac, as opposed to a sandbox); the plan is Dorks Free (its id stays `local`). The app labels each workspace by plan: Free, Teams, Cloud. Sandboxes are only for Teams and Cloud (`services/plan.ts`: a free workspace's server refuses to create or wake one; `DORKS_SANDBOXES_WITHOUT_PLAN=1` lifts that for development); a sandbox chat made before keeps its transcript and does not wake.

A paid plan always runs on the dorks-cloud Worker, never on a Mac, and the personal workspace can take one too: upgrading it moves its
sessions, builds and the rest to the cloud ([move to cloud](move-to-cloud.md)).

The cloud named these `free` and `collab` before (dorks-cloud#20 renamed them, with `hostedServer` becoming `orgRuntime`). `apps/server`
and the app still read `free` as `local` and `collab` as `teams` (`planOf` in `packages/shared/src/plans.ts`), in identity tokens and
`GET /v1/orgs` alike, so a cloud on either side of the rename works.

**Pricing** (the numbers live in one `PLAN_CONFIG` in dorks-cloud's `src/entitlements.ts`):

- **One flat price per org**, never per seat.
- **Unlimited members, with a fair-use cap** on Teams and Cloud (50 for now; Local has 1). An invitation that would reach it, counting
  members plus open invitations, gets `403 MEMBER_LIMIT_REACHED` (on Local: "Dorks Local is for one person…").
- **Dorks Cloud includes 12,000 sandbox minutes a month** (200 hours) on Dorks' Boat account, at most 3 sandboxes at once. Past the
  allowance, runs **stop** (`allowance_used`) unless the owner turns on **overage**: minutes at 1.5x Boat's price (0.09¢/minute), up to
  a monthly cap the owner sets (default $20). Runs on an org's own Boat key are not metered, and Teams never draws on Dorks' credit.
- **Switching**: Teams to Cloud is immediate and prorated; Cloud to Teams waits for the period's end. Only the org's owner manages billing.

`GET /v1/orgs/:orgId/entitlements` (members only) answers
`{plan: "local"|"teams"|"cloud", memberLimit, members, orgRuntime, cloudCredit, includedMinutes, usedMinutes, periodEnd,
overage: {enabled, capCents, spentCents}, maxConcurrentSandboxes}`.

## Servers belong to orgs

A server is a Mac paired through the relay, or the server Dorks runs for a Teams or Cloud org (its `orgRuntime`, `kind: "hosted"`). Either way it belongs to one
org (`macs.org_id`), and every member of that org sees it in `GET /v1/macs` and can reach it through the relay. Teammates always go
through the relay: there is no direct connection to a server.

A server learns its org when it pairs (`orgId` in the claimed answer of `POST /v1/pair/poll`) and again each time its link opens
(`PATCH /v1/mac`, which answers `{macId, name, orgId, kind, pairedBy?}`), so a Mac paired before teams existed picks it up. It keeps it in
`settings.cloud_org_id`; the server Dorks runs for an org is started with `DORKS_ORG_ID` instead ([env](env.md)). `pairedBy: {id, name, email}` is
who paired it: the server keeps it (`settings.cloud_owner`) and treats the local owner as that person.

## Identity

The cloud signs a short-lived JWT for whoever makes a request: Better Auth's `jwt` plugin, EdDSA (Ed25519), keys published at
`<cloud>/api/auth/jwks`, 10 minutes, `iss` and `aud` both the cloud's URL (`BETTER_AUTH_URL`). Claims:

| Claim | Meaning |
|---|---|
| `sub` | The user's id |
| `name`, `email` | Who they are, for attribution and for the agent |
| `org` | The org that owns the target server (not the session's active org) |
| `role` | Their role in that org: `owner`, `admin` or `member` |
| `plan` | The org's plan: `local`, `teams` or `cloud` (`free` and `collab` read as `local` and `teams`) |

The relay puts it in the `x-dorks-actor` header of every request frame it sends a server ([mobile](mobile.md), "Link protocol").
`GET /api/auth/token` returns the same token for the session's active org.

## This server (`apps/server`)

`services/team.ts` decides who a request is (its **actor**), `core/jwt.ts` checks tokens, `services/presence.ts` keeps presence.

- **The local owner** holds the owner token on loopback (the desktop app, the web app, `pnpm dev`) and may do anything, as before.
  Once the cloud named them (`pairedBy`), their messages, chats, presence and `GET /api/me` carry that user's id and name, so
  teammates see a real name and the owner's own phone (the same user id) sees their messages as theirs. Before that they are "Owner".
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
| admin, owner | Everything a member may, plus settings writes, secret **names** (and setting or deleting a secret), automations (create, edit, delete, run now, Sentry projects), builds (every route) and skills (install, update, remove). Deleting anyone's preview comment (moderation); editing one stays with its author. |

Never, for any role: local access (`/api/dorks/:id/local/*`, `/api/local-access`), secure inputs (`/api/dorks/:id/inputs/*`), the
box's live desktop, MCP server definitions, sign-ins (Boat, Antigravity, the snapshot build), phone pairing, `/mcp` and the sim
routes. Secret values never leave the server, as before.

### Attribution and the agent

Everything a teammate does is stored with who did it, as `{id, name}` (the local owner only once the cloud named them; a schedule and an event store nothing):

- **Messages**: the `user_message` event carries `by`; a queued message keeps it (`queued_messages.sent_by`) until it goes out.
- **Sessions**: `dorks.created_by`, `createdBy` on the dork.
- **Automation runs**: a run started by hand carries `by` (`automation_runs.run_by`), and the session it starts is created by them.

The agent is told who wrote each message in a shared chat: the text it receives starts with
`[Message from Ada Lovelace (ada@team.test)]` and a blank line, so it can address people and knows who asked for what. A teammate's
message always says so; the local owner's does once someone else has written in that chat (a solo owner's agent sees nothing new). The transcript keeps the message as
written, with `by` beside it.

The web app names the sender over a user bubble that is not yours (a message without `by` on a team server is the owner's), shows
the initials of whoever started a chat at the end of its sidebar row, and shows who else is looking in the chat's header.

### Presence

In memory only. A client (a tab, a phone) opens `/api/live?client=<id>` (8 to 64 letters, digits, `-` or `_`) and says which dork
it shows with `POST /api/presence {client, dorkId | null}`. It counts while its live stream is open, or for a minute after it posted
when it has none. Every live stream gets `{t: "presence", dorkId, viewers: [{id, name}]}` right after `hello` for each dork with
viewers, then whenever a dork's viewers change. The local owner shows by their cloud id and name, else as `{id: "owner", name: "Owner"}`. A person's client ids are
kept under their own id, so nobody can move another person's presence.

### `GET /api/me`

`{kind: "local"|"phone"|"member", id, name, email, role, org, plan, serverOrg}`: who this request is (the local owner's cloud id and name once known, else null)
and the org the server belongs to.
