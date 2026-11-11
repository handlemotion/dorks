# Security

## Reporting a vulnerability

Email the maintainers through the address on the GitHub profile of the repository owner, or open a private security advisory on GitHub ("Security" tab, "Report a vulnerability"). Do not file a public issue with exploit details. Include what you found, how to reproduce it and the version or commit.

## Threat model

Dorks is a single-owner app. The owner runs the server on their own machine, and agents run in the owner's Boat sandboxes. The one hosted piece is the tunnel service (below), which hands out tunnel access and never sees traffic.

| Surface | Exposure | Protection |
|---|---|---|
| UI API and live stream | `127.0.0.1:<ui port>` only | Bearer owner token, CORS limited to `DORKS_UI_ORIGINS`. |
| Bridge socket | `127.0.0.1:<bridge port>`, and the **only** thing the tunnel forwards (`DORKS_PUBLIC_URL`) | Only `/bridge` upgrades to a WebSocket; `/` answers 404. The first frame must authenticate as one dork with `HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)`. Wrong secret, unknown or deleting dork, or no first frame within 5 s closes the socket (code 4403). |
| Data at rest | `<data dir>/dorks.db` and `secrets.json` | Boat key, Claude token, GitHub token and CLI secrets are AES-GCM encrypted, with additional data binding each to its purpose. `secrets.json` is mode 600 and holds the three server keys. |
| Secrets in transit to a sandbox | Bridge socket | Decrypted only inside the `configure` rpc of an authenticated socket. Never stored in a command row, never in the sandbox's creation environment. The creation environment holds only `DORK_ID`, `BRIDGE_URL` and `BRIDGE_SECRET`, plus `DORKS_TUNNEL_SERVICE` and `DORKS_TUNNEL_TICKET` with the embedded tunnel. |

### The tunnel and who can reach it

The desktop app's public URL is a private embedded wurmhol tunnel (wurmhol ADR 0032), one per install. The relay lets a request through only with a grant for a subject on that tunnel's access list, and the list holds only this install's sandboxes (`dork-<id>`). Members of Dorks' wurmhol org, owners included, see the tunnel's health and can stop or delete it, but cannot open it.

- **The tunnel service** (`infra/tunnels`) is the only holder of Dorks' wurmhol integration key (`whk_`). It knows an install by its install key (`tunnel-install-key`, 0600 on the Mac, `dti_` + 64 hex): the install's tenant is derived from it, so no install can reach another's tunnel or sandboxes. It stores nothing and never sees traffic.
- **The connector** (`whc_`, 0600 in `wurmhol-connector`) opens that one tunnel and nothing else. Asking for a new one revokes the old.
- **A sandbox** holds a ticket (`dts_`, signed by the service) for its own subject only, and trades it for 12-hour grants (`whg_`) that it sends as `x-wurmhol-grant`. Deleting the dork removes the subject, which revokes its grants and makes the ticket worthless. Code in a sandbox can read its ticket; it only ever reaches this one bridge socket.
- **What it does not do:** it does not authenticate a dork. A grant gets a client to the bridge socket's front door; the first frame still needs that dork's HMAC, or the socket closes.
- **What it does not hide:** whoever runs the tunnel service can issue a grant for a subject on the list, as any embedding app's backend can. Each grant is in the tunnel's grant log at wurmhol. Even then the per-dork HMAC, which never leaves the owner's Mac and the dork's own box, keeps them out of the bridge protocol. And the relay terminates TLS, as for every wurmhol pipe: this is access isolation, not end-to-end encryption.
- Not used for a public URL you supply.

What the tunnel exposes is one authenticated WebSocket endpoint, not the UI API. Keep it that way: forward the bridge port and never the UI port. Use a tunnel with TLS (the server requires an `https://` public URL).

### What a sandbox can read

Code running in a sandbox runs with the agent's privileges and should be treated as able to read everything the dork was given:

- the GitHub token (it is how the agent pushes and uses `gh`),
- the Claude token, if you set one,
- your CLI secrets,
- for Codex dorks, your ChatGPT sign-in, which Boat installs through the selected environment. Linux permissions inside the box do not protect it from code that can use `sudo`,
- that dork's bridge secret,
- whatever its desktop shows: code in the box can drive Boat's computer tools and read the screen and Chrome, including pages you sign in to while you have control in the Computer tab.

The Computer tab's stream URL is a bearer credential to that interactive desktop. The server mints it per view, returns it only over the owner-authenticated UI API with `Cache-Control: no-store`, and never stores or logs it ([computer use](docs/computer-use.md)).

So: use dorks only on repositories you trust, scope the GitHub token to the repositories you need (a fine-grained token, see [GitHub](docs/github.md)), and do not hand a dork a token that can do more than you would let its code do. A sandbox cannot reach other dorks' bridge sessions (secrets are per dork) or the UI API (loopback only).

### Dev server previews

When the agent shows a dev server (`preview_show`), the port is hosted on Boat **without a token** (see [Boat](docs/boat.md#hosted-ports) for why), so the page is public until the box is stopped or replaced. Anyone who learns its `*.on.boat.dev` URL can open it. Do not let the agent show a server that exposes secrets or write access.

### Not defended against

- Anyone with access to your user account on the machine (they can read `secrets.json`).
- A malicious repository run by the agent, which can use the credentials above.
- A leaked `DORKS_PUBLIC_URL` together with a leaked per-dork secret: the socket would accept that dork's bridge. Deleting the dork ends that. Changing `bridgeSecretKey` in `secrets.json` invalidates every existing sandbox.

## Supply chain

CI runs with no repository secrets. Workflow actions are pinned by commit SHA. Do not add secrets to workflows that run on pull requests from forks.
