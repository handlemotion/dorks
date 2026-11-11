# Dorks tunnel service

The one hosted piece of Dorks. It holds Dorks' wurmhol **integration key** (`whk_…`, wurmhol ADR 0032, "Embedded tunnels") so that
nothing on a user's Mac or in a sandbox ever does, and gives each Dorks install one private wurmhol tunnel to its bridge port that
only that install's sandboxes can reach. Nobody in Dorks' wurmhol org can open those tunnels; the console shows their health only.

It stores nothing and never sees tunnel traffic. How it fits with the desktop shell, the server and the bridge:
[docs/desktop.md](../../docs/desktop.md) ("Tunnel: wurmhol"); the security model: [SECURITY.md](../../SECURITY.md).

## API

| Route | Auth | Does |
|---|---|---|
| `POST /v1/tunnel` | `Bearer dti_…` (the install key) | Makes the install's tenant (`install-<40 hex of sha256(key)>`, at most 1 open tunnel), its `owner` subject and its tunnel on first use. Answers `{tunnel: {id, url}, connector: {connector, expiresAt}}` with a new 365-day connector; older ones are revoked. |
| `PUT /v1/sandboxes/:dork` | `Bearer dti_…` | Puts subject `dork-<id>` (a service) on the install's tunnel's access list. Answers `{ticket}` (`dts_…`, signed with `TICKET_KEY`). |
| `DELETE /v1/sandboxes/:dork` | `Bearer dti_…` | Removes the subject, which revokes its grants and ends its ticket. `204`, also when it did not exist. |
| `POST /v1/grants` | `Bearer dts_…` (a ticket) | A 12-hour client grant for the ticket's own subject: `{token: "whg_…", expiresAt}`. `403 revoked` once the subject is gone. |
| `GET /health` | none | `{ok: true}` |

Refusals are `{error, fix}`. A wurmhol `404` on `/v1/embed` means embedded mode is not on for that wurmhol server.

The owner subject is never granted traffic, and a ticket can only name a `dork-` subject. Whoever runs this service can mint a
grant for a subject on any list (as any embedding backend can; each grant is in wurmhol's grant log), but a grant only reaches the
bridge socket, where the first frame still needs the dork's HMAC, which never leaves the owner's Mac and the dork's box.

## Deploy (Cloudflare Worker)

Not deployed yet. Needs, in this order, and none of it is in the repo:

1. A wurmhol org on Business with embedded mode on (wurmhol.com from the deploy with `EMBEDDED_ENABLED`).
2. An application for Dorks in that org, and an integration key with `tunnels:read`, `tunnels:manage`, `subjects:manage` and
   `grants:issue` (console → Apps, or `POST /api/apps/:id/keys`).
3. `wrangler secret put WURMHOL_KEY` (that key) and `wrangler secret put TICKET_KEY` (32+ random bytes; rotating it ends every
   sandbox's ticket, so existing sandboxes then need recreating).
4. A route for the Worker at the URL the desktop shell defaults to (`DEFAULT_TUNNEL_SERVICE`, `https://tunnels.dorks.build`), or
   change that constant. Optional var: `TENANT_MONTHLY_REQUESTS`, a monthly request cap per install; `WURMHOL_SERVER` for a
   self-hosted wurmhol.

Anyone can make an install key, so anyone can get one tunnel billed to Dorks' org. The per-tenant cap of one open tunnel and the
optional monthly cap bound that; add a Cloudflare rate limit on `POST /v1/tunnel` when it is deployed.

```sh
pnpm --filter @dorks/tunnels test
```
