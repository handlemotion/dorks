# Security

## Reporting a vulnerability

Email the maintainers through the address on the GitHub profile of the repository owner, or open a private security advisory on GitHub ("Security" tab, "Report a vulnerability"). Do not file a public issue with exploit details. Include what you found, how to reproduce it and the version or commit.

## Threat model

Dorks is a single-owner app. The owner runs the server on their own machine, and agents run in the owner's Boat sandboxes. Nothing is hosted for you.

| Surface | Exposure | Protection |
|---|---|---|
| UI API and live stream | `127.0.0.1:<ui port>` only | Bearer owner token, CORS limited to `DORKS_UI_ORIGINS`. |
| Bridge socket | `127.0.0.1:<bridge port>`, and the **only** thing the tunnel forwards (`DORKS_PUBLIC_URL`) | Only `/bridge` upgrades to a WebSocket; `/` answers 404. The first frame must authenticate as one dork with `HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)`. Wrong secret, unknown or deleting dork, or no first frame within 5 s closes the socket (code 4403). |
| Data at rest | `<data dir>/dorks.db` and `secrets.json` | Boat key, Claude token, GitHub token and CLI secrets are AES-GCM encrypted, with additional data binding each to its purpose. `secrets.json` is mode 600 and holds the three server keys. |
| Secrets in transit to a sandbox | Bridge socket | Decrypted only inside the `configure` rpc of an authenticated socket. Never stored in a command row, never in the sandbox's creation environment. The creation environment holds only `DORK_ID`, `BRIDGE_URL` and `BRIDGE_SECRET`. |

### The tunnel access key

When the tunnel is a wurmhol pipe, the shell also makes an access key for it (`wurmhol-access-key`, mode 600), passes it to the client as `WURMHOL_ACCESS_KEY`, and gives it to the server (`DORKS_TUNNEL_KEY`), which puts it in every sandbox's creation environment. The bridge sends it as `x-wurmhol-key`. What it does: wurmhol normally answers only a browser signed in to the owner's organisation, so without a key a sandbox cannot connect at all; with the key the relay lets that one pipe through (the relay stores only its hash). What it does not do: it does not authenticate a dork. Anyone who holds the key can reach the bridge socket's front door, and still needs a valid per-dork HMAC for the first frame, or the socket closes. Treat it like any other sandbox-held value: code in a sandbox can read it, and it only ever opens this one pipe. To rotate it, delete `wurmhol-access-key` in the app directory and restart; existing sandboxes then need recreating. It is not used for a public URL you supply.

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

### Not defended against

- Anyone with access to your user account on the machine (they can read `secrets.json`).
- A malicious repository run by the agent, which can use the credentials above.
- A leaked `DORKS_PUBLIC_URL` together with a leaked per-dork secret: the socket would accept that dork's bridge. Deleting the dork ends that. Changing `bridgeSecretKey` in `secrets.json` invalidates every existing sandbox.

## Supply chain

CI runs with no repository secrets. Workflow actions are pinned by commit SHA. Do not add secrets to workflows that run on pull requests from forks.
