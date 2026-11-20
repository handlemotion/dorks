# MCP servers (Customize)

The owner adds MCP servers in **Customize**; every Claude agent gets their tools, in every sandbox, next to the built-in `dorks` server
(`infra/bridge/src/mcp.ts`). A server's tools show up as `mcp__<name>__<tool>`.

- **Connectors** (`apps/web/src/components/connectors.ts`): cards for popular servers (Linear, Sentry, Cloudflare, Firecrawl,
  Notion, Supabase, Stripe, PostHog, Neon, Context7). Each takes one key and saves an ordinary server named after the card. Only
  servers that accept a static token belong here: a sandbox has no browser to finish an OAuth sign-in.
- **Apps through Composio** (Figma, Slack, Gmail, Google Drive and Calendar, Jira, Asana, HubSpot): apps that only sign in with
  OAuth. The owner saves a Composio API key once (`PUT /api/composio`); the server checks it by opening a Composio tool router session
  and saves that session as the ordinary server `composio` (its MCP URL, the key as the `x-api-key` header). Each app card then asks
  for a sign-in link (`POST /api/composio/toolkits/:toolkit/link`), opens it in the browser, and polls `GET /api/composio` until the
  app is a connected account of the one Composio user `dorks-owner`. `DELETE /api/composio/toolkits/:toolkit` signs one app out;
  `DELETE /api/composio` removes the key and the server (`apps/server/src/services/composio.ts`).
- **Custom remote (HTTP):** a URL plus optional headers, for any other hosted server (Streamable HTTP).
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

Names are lowercase (`^[a-z][a-z0-9_-]{0,31}$`); `dorks` and `computer` (Boat's computer-use server) are reserved. Codex sessions do
not get these servers yet.
