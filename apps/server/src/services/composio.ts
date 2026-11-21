import type { ComposioStatus } from "@dorks/shared";
import { AppFail, fail, OWNER, type App } from "../app";
import { aad, decrypt } from "../core/crypto";
import { deleteMcpServer, putMcpServer } from "./mcpServers";

// Composio (docs/mcp.md): the apps that only sign in with OAuth (Figma, Slack, Gmail…) reach agents through one Composio MCP server.
// The owner saves a Composio API key once; it becomes the `composio` MCP server (a tool router session's URL plus the key as a header,
// sealed like any server's headers), and each app is a connected account of one Composio user that the owner signs in to in a browser.

export const COMPOSIO_SERVER = "composio";
const API = "https://backend.composio.dev/api";
const USER_ID = "dorks-owner";
const TOOLKIT = /^[a-z0-9_]{1,64}$/;
const KEY_HEADER = "x-api-key";

interface Account {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
}

/** Composio's own explanation of a refusal (`{error: {message}}`), so the owner sees why, not just that, it failed. Keys in it are already masked. */
async function reason(res: Response): Promise<string | undefined> {
  try {
    const m = ((await res.json()) as { error?: { message?: unknown } })?.error?.message;
    return typeof m === "string" && m.trim() ? m.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

async function call<T>(app: App, key: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await app.fetch(`${API}${path}`, {
      method,
      headers: { [KEY_HEADER]: key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("failed", "Composio could not be reached");
  }
  if (res.status === 401 || res.status === 403) {
    const why = await reason(res);
    fail("invalid", why ? `Composio did not accept this API key: ${why}` : "Composio did not accept this API key");
  }
  if (!res.ok) {
    const why = await reason(res);
    fail("failed", why ? `Composio answered ${res.status}: ${why}` : `Composio answered ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The saved key, from the `composio` server's sealed headers. */
async function savedKey(app: App): Promise<string | undefined> {
  const r = app.db.get<{ secrets_enc: string }>("SELECT secrets_enc FROM mcp_servers WHERE name = ?", COMPOSIO_SERVER);
  if (!r) return undefined;
  const sealed = JSON.parse(await decrypt(app.ring, r.secrets_enc, aad.mcpServer(OWNER, COMPOSIO_SERVER))) as { headers: Record<string, string> };
  return sealed.headers[KEY_HEADER];
}

const newSession = (app: App, key: string) => call<{ session_id: string; mcp: { url: string } }>(app, key, "POST", "/v3.1/tool_router/session", { user_id: USER_ID });

/** Checks the key by opening a session, then saves the session's MCP server for every agent. */
export async function connectComposio(app: App, apiKey: unknown): Promise<void> {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512) fail("invalid", "enter a Composio API key");
  const key = apiKey.trim();
  const s = await newSession(app, key);
  if (typeof s?.mcp?.url !== "string") fail("failed", "Composio returned no MCP URL");
  await putMcpServer(app, COMPOSIO_SERVER, { transport: "http", url: s.mcp.url, headers: { [KEY_HEADER]: key } });
}

export const disconnectComposio = (app: App) => deleteMcpServer(app, COMPOSIO_SERVER);

async function accounts(app: App, key: string, toolkit?: string): Promise<Account[]> {
  const q = new URLSearchParams({ user_ids: USER_ID, statuses: "ACTIVE", limit: "200" });
  if (toolkit) q.set("toolkit_slugs", toolkit);
  return (await call<{ items?: Account[] }>(app, key, "GET", `/v3/connected_accounts?${q}`)).items ?? [];
}

/** Whether a key is saved, and the apps signed in through it. */
export async function composioStatus(app: App): Promise<ComposioStatus> {
  const key = await savedKey(app);
  if (!key) return { connected: false, toolkits: [] };
  let list: Account[];
  try {
    list = await accounts(app, key);
  } catch (e) {
    return { connected: true, toolkits: [], error: e instanceof AppFail ? e.error.message : "Composio could not be read" };
  }
  const slugs = list.map((a) => a.toolkit?.slug).filter((s): s is string => !!s);
  return { connected: true, toolkits: [...new Set(slugs)].sort() };
}

const toolkitOf = (v: string) => (TOOLKIT.test(v) ? v : fail("invalid", "unknown app"));

async function requireKey(app: App) {
  return (await savedKey(app)) ?? fail("not_configured", "Add your Composio API key first.");
}

/** A Composio sign-in page for one app; the owner finishes it in a browser and the account shows up in `composioStatus`. */
export async function composioLink(app: App, toolkit: string): Promise<{ url: string }> {
  const key = await requireKey(app);
  const s = await newSession(app, key);
  const link = await call<{ redirect_url?: string }>(app, key, "POST", `/v3.1/tool_router/session/${encodeURIComponent(s.session_id)}/link`, { toolkit: toolkitOf(toolkit) });
  if (!link.redirect_url?.startsWith("https://")) fail("failed", "Composio returned no sign-in link");
  return { url: link.redirect_url };
}

/** Signs one app out: deletes its connected accounts. */
export async function composioUnlink(app: App, toolkit: string): Promise<void> {
  const key = await requireKey(app);
  const slug = toolkitOf(toolkit);
  for (const a of (await accounts(app, key, slug)).filter((x) => x.toolkit?.slug === slug)) await call(app, key, "DELETE", `/v3/connected_accounts/${encodeURIComponent(a.id)}`);
}
