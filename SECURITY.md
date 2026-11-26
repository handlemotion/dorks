# Security

## Reporting a vulnerability

Email the maintainers through the address on the GitHub profile of the repository owner, or open a private security advisory on GitHub ("Security" tab, "Report a vulnerability"). Do not file a public issue with exploit details. Include what you found, how to reproduce it and the version or commit.

## Threat model

Dorks is a single-owner app. The owner runs the server on their own machine, and agents run in the owner's Boat sandboxes. Nothing is hosted for Dorks itself: the owner's machine dials out to the sandboxes and accepts no inbound connections.

| Surface | Exposure | Protection |
|---|---|---|
| UI API and live stream | `127.0.0.1:<ui port>` only | Bearer owner token, CORS limited to `DORKS_UI_ORIGINS`. |
| Bridge socket | Inside each sandbox, reached by the server through Boat's hosted-port URL for that box | Boat's per-port token (`_port_auth` cookie) in front; then a challenge-response in both directions proving the per-dork HMAC secret before anything else crosses the socket. The secret is never sent. |
| Data at rest | `<data dir>/dorks.db` and `secrets.json` | Boat key, Claude token and CLI secrets are AES-GCM encrypted (the GitHub token is never stored: the server reads it from the GitHub CLI when needed), with additional data binding each to its purpose. `secrets.json` is mode 600 and holds the three server keys. |
| Secrets in transit to a sandbox | Bridge socket | Decrypted only inside the `configure` rpc of an authenticated socket. Never stored in a command row, never in the sandbox's creation environment. The creation environment holds only `DORK_ID`, `BRIDGE_PORT` and `BRIDGE_SECRET`. |

### How the server reaches a sandbox

The server reaches each sandbox's bridge through Boat's hosted-port URL for that box (protected by Boat's per-port token, sent as the `_port_auth` cookie). The owner's machine opens no inbound port. Both sides prove they hold the per-dork HMAC secret with a challenge-response before anything else crosses the socket; the secret itself never does.

### What a sandbox can read

Code running in a sandbox runs with the agent's privileges and should be treated as able to read everything the dork was given:

- the GitHub token (it is how the agent pushes and uses `gh`),
- the Claude token, if you set one,
- your CLI secrets,
- for Codex dorks, a ChatGPT access token from Dorks' own sign-in (short-lived; the refresh token stays on your computer), or, with a Boat environment instead, the sign-in Boat installs. Linux permissions inside the box do not protect either from code that can use `sudo`,
- that dork's bridge secret,
- whatever its desktop shows: code in the box can drive Boat's computer tools and read the screen and Chrome, including pages you sign in to while you have control in the Computer tab.

The Computer tab's stream URL is a bearer credential to that interactive desktop. The server mints it per view, returns it only over the owner-authenticated UI API with `Cache-Control: no-store`, and never stores or logs it ([computer use](docs/computer-use.md)).

So: use dorks only on repositories you trust, and remember the GitHub token is your GitHub CLI login's: it can do everything you can. To narrow it, sign `gh` in as a dedicated account that only has the repositories dorks should touch ([GitHub](docs/github.md)). A sandbox cannot reach other dorks' bridge sessions (secrets are per dork) or the UI API (loopback only).

### Dev server previews

When the agent shows a dev server (`preview_show`), the port is hosted on Boat **without a token** (see [Boat](docs/boat.md#hosted-ports) for why), so the page is public until the box is stopped or replaced. Anyone who learns its `*.on.boat.dev` URL can open it. Do not let the agent show a server that exposes secrets or write access.

### Not defended against

- Anyone with access to your user account on the machine (they can read `secrets.json`).
- A malicious repository run by the agent, which can use the credentials above.
- A leaked per-dork secret together with that box's hosted-port token: whoever holds both could pass the challenge-response as that dork's server. Deleting the dork ends that. Changing `bridgeSecretKey` in `secrets.json` invalidates every existing sandbox.

## Supply chain

CI runs with no repository secrets. Workflow actions are pinned by commit SHA. Do not add secrets to workflows that run on pull requests from forks.
