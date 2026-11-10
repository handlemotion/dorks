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

What the tunnel exposes is one authenticated WebSocket endpoint, not the UI API. Keep it that way: forward the bridge port and never the UI port. Use a tunnel with TLS (the server requires an `https://` public URL).

### What a sandbox can read

Code running in a sandbox runs with the agent's privileges and should be treated as able to read everything the dork was given:

- the GitHub token (it is how the agent pushes and uses `gh`),
- the Claude token, if you set one,
- your CLI secrets,
- for Codex dorks, your ChatGPT sign-in, which Boat installs through the selected environment. Linux permissions inside the box do not protect it from code that can use `sudo`,
- that dork's bridge secret.

So: use dorks only on repositories you trust, scope the GitHub token to the repositories you need (a fine-grained token, see [GitHub](docs/github.md)), and do not hand a dork a token that can do more than you would let its code do. A sandbox cannot reach other dorks' bridge sessions (secrets are per dork) or the UI API (loopback only).

### Not defended against

- Anyone with access to your user account on the machine (they can read `secrets.json`).
- A malicious repository run by the agent, which can use the credentials above.
- A leaked `DORKS_PUBLIC_URL` together with a leaked per-dork secret: the socket would accept that dork's bridge. Deleting the dork ends that. Changing `bridgeSecretKey` in `secrets.json` invalidates every existing sandbox.

## Supply chain

CI runs with no repository secrets. Workflow actions are pinned by commit SHA. Do not add secrets to workflows that run on pull requests from forks.
