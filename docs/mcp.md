# MCP servers (Customize)

The owner adds MCP servers in **Customize**; every Claude agent gets their tools, in every sandbox, next to the built-in `dorks` server
(`infra/bridge/src/mcp.ts`). A server's tools show up as `mcp__<name>__<tool>`.

- **Connectors** (`apps/web/src/components/connectors.ts`): cards for popular servers, shown in sections by kind
  (Engineering, Web and docs, Planning, Design, Communication, Docs and files, Customers; `KINDS`). Key connectors (Sentry, PostHog,
  Cloudflare, Render, Supabase, Neon, Context7, Firecrawl, Exa, Brave Search, Apify, Linear, Notion, Stripe) each take one key and saves an ordinary server named after the card. Only
  servers that accept a static token belong here (an OAuth server is a custom remote one, see "OAuth").
- **Apps through Composio** (Figma, Canva, Miro, Slack, Gmail, Outlook, Microsoft Teams, Discord, Zoom, Google Docs, Sheets, Drive
  and Calendar, Confluence, Airtable, Dropbox, Jira, Asana, Trello, ClickUp, Calendly, HubSpot, Salesforce, Intercom, Zendesk): apps
  that only sign in with OAuth. Only toolkits with a Composio-managed OAuth app belong here, since the owner brings no OAuth app. The owner saves a Composio API key once (`PUT /api/composio`); the server checks it by opening a Composio tool router session
  and saves that session as the ordinary server `composio` (its MCP URL, the key as the `x-api-key` header). Each app card then asks
  for a sign-in link (`POST /api/composio/toolkits/:toolkit/link`), opens it in the browser, and polls `GET /api/composio` until the
  app is a connected account of the one Composio user `dorks-owner`. `DELETE /api/composio/toolkits/:toolkit` signs one app out;
  `DELETE /api/composio` removes the key and the server (`apps/server/src/services/composio.ts`).
- **Custom remote (HTTP):** a URL plus optional headers, for any other hosted server (Streamable HTTP). One that asks for an OAuth
  sign-in gets a **Sign in** button (see "OAuth" below); saving it opens the sign-in straight away.
- **Local command (stdio):** a command, arguments and environment variables. The command runs inside the sandbox, so it must exist
  there (`npx` does on the base image; anything else belongs in a build's setup, see `builds.md`).

## Where the values go

1. `PUT /api/mcp-servers/:name` stores the server in `mcp_servers` (`apps/server/src/services/mcpServers.ts`). Header and env values
   are sealed in one AES-GCM envelope per server; `GET /api/mcp-servers` returns their names only. On a replace, a `null` value keeps
   the saved one, so editing a URL does not ask for the token again.
2. The `configure` frame carries `mcpServers` with the values in clear, like the other secrets: only over the authenticated bridge
   socket, never in a command row.
3. The bridge (`userMcpServers` in `infra/bridge/src/hooks.ts`) writes them into `claude-mcp.json` as `${DORKS_MCP_<i>_…}` references,
   URL included (hosted servers often carry a key in it), and puts the values in the agent's environment. Claude Code expands the
   references when it loads `--mcp-config`, so no value is written to disk.
4. A change restarts every awake Claude agent on its session once its current turn ends (a fresh `configure`, as for a model change);
   sleeping ones get it on their next wake.

## OAuth

A remote server that answers an unauthenticated `initialize` with 401 and publishes authorization metadata is an OAuth server
(`apps/server/src/services/mcpOAuth.ts`). Saving it (without an `Authorization` header of its own) marks it `signed_out`; agents
do not get it until the owner signs in. The sign-in runs on the dorks server, in the owner's browser, never in a sandbox:

1. Discovery: the 401's `resource_metadata` (RFC 9728, else the well-known paths), then the authorization server's RFC 8414 or
   OpenID metadata. A server without protected resource metadata is its own authorization server (the 2025-03-26 spec).
2. Dynamic client registration (RFC 7591) as a public client, with `<server URL>/oauth/mcp/callback` as the redirect. The
   registration is kept and reused while the issuer and redirect stay the same. A server without a registration endpoint is refused
   with a hint to use a token header instead.
3. `POST /api/mcp-servers/:name/oauth {base}` returns the authorization URL (PKCE S256, a `resource` indicator, the challenge's
   scope plus `offline_access` when offered). `base` is the URL the browser reaches this server at. The callback
   (`GET /oauth/mcp/callback`, no token: the single-use random `state` is the capability) swaps the code for tokens, seals them with
   the server's other values, marks it `signed_in` and restarts awake agents once their turn ends.
4. Agents never hold the refresh token. The configure frame marks the server `oauth: true` without a token; the bridge points the
   agent's config at its loopback proxy (`infra/bridge/src/mcp-proxy.ts`, a random secret path passed by `${…}` reference), which
   adds a current `Authorization` from the bridge RPC `mcp_token {name, stale?}`. The server refreshes the token when it is within a
   minute of expiry, or when the bridge reports it refused (`stale`). A 401 gets one retry with a refreshed token.
5. A refresh the authorization server rejects (`invalid_grant`) signs the server out; Customize offers the sign-in again.
   `DELETE /api/mcp-servers/:name/oauth` signs out by hand. Pending sign-ins live in memory for ten minutes.

Composio stays for apps that only sign in with OAuth and have no MCP server of their own.

Names are lowercase (`^[a-z][a-z0-9_-]{0,31}$`); `dorks` and `computer` (Boat's computer-use server) are reserved. Codex sessions do
not get these servers yet.
