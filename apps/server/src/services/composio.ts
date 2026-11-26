import type { ComposioStatus } from "@dorks/shared";
import { AppFail, fail, OWNER, type App } from "../app";
import { aad, decrypt } from "@dorks/core/crypto";
import { deleteMcpServer, putMcpServer } from "./mcpServers";

// Composio (docs/mcp.md): the apps that only sign in with OAuth (Figma, Slack, Gmail…) reach agents through one Composio MCP server.
// The owner saves a Composio API key once; it becomes the `composio` MCP server (a tool router session's URL plus the key as a header,
// sealed like any server's headers), and each app is a connected account of one Composio user that the owner signs in to in a browser.
//
// Two kinds of key work. A project key (`ak_…`, `x-api-key`) acts in one developer project as the user `dorks-owner`. A personal
// user key (`uak_…`, `x-user-api-key`, Composio's "For You") acts in the owner's consumer project as the owner's own Composio user,
// so the apps already connected in For You, its Instant setting and the account's credits all carry over. Composio scopes such a key
// with `x-org-id` + `x-project-id`, which the session's MCP server needs too (docs.composio.dev/docs/consumer-agents).

export const COMPOSIO_SERVER = "composio";
const API = "https://backend.composio.dev/api";
const USER_ID = "dorks-owner";
const TOOLKIT = /^[a-z0-9_]{1,64}$/;
const KEY_HEADER = "x-api-key";
const USER_KEY_HEADER = "x-user-api-key";
const ORG_HEADER = "x-org-id";
const PROJECT_HEADER = "x-project-id";
const NANO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How to act on Composio: the headers every request (and the MCP server) carries, and the Composio user the apps belong to. */
interface Cred {
  headers: Record<string, string>;
  userId: string;
  /** A personal key's consumer project: whether Instant (tools billed to the account's credits, such as web search) is on. */
  instant?: boolean;
}

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

async function call<T>(app: App, auth: Record<string, string>, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await app.fetch(`${API}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

/** A personal key's consumer project, resolved (and provisioned when absent) in the key's own organization. */
async function personal(app: App, key: string, orgId?: string): Promise<Cred> {
  const auth = { [USER_KEY_HEADER]: key };
  if (!orgId) {
    const info = await call<{ project?: { org?: { id?: unknown } } }>(app, auth, "GET", "/v3.1/auth/session/info");
    if (typeof info?.project?.org?.id !== "string") fail("failed", "Composio returned no organization for this key");
    orgId = info.project.org.id;
  }
  const p = await call<{ org_id?: unknown; project_nano_id?: unknown; consumer_user_id?: unknown; config?: { enable_instant?: unknown } }>(
    app,
    { ...auth, [ORG_HEADER]: orgId },
    "POST",
    "/v3.1/org/consumer/project/resolve",
  );
  const org = typeof p?.org_id === "string" ? p.org_id : orgId;
  if (!NANO_ID.test(org) || typeof p?.project_nano_id !== "string" || !NANO_ID.test(p.project_nano_id) || typeof p.consumer_user_id !== "string" || !p.consumer_user_id)
    fail("failed", "Composio returned no personal project for this key");
  return {
    headers: { ...auth, [ORG_HEADER]: org, [PROJECT_HEADER]: p.project_nano_id },
    userId: p.consumer_user_id,
    instant: typeof p.config?.enable_instant === "boolean" ? p.config.enable_instant : undefined,
  };
}

const credOf = (app: App, key: string): Promise<Cred> | Cred => (key.startsWith("uak_") ? personal(app, key) : { headers: { [KEY_HEADER]: key }, userId: USER_ID });

/** The saved credential, from the `composio` server's sealed headers. */
async function savedCred(app: App): Promise<Cred | undefined> {
  const r = app.db.get<{ secrets_enc: string }>("SELECT secrets_enc FROM mcp_servers WHERE name = ?", COMPOSIO_SERVER);
  if (!r) return undefined;
  const { headers } = JSON.parse(await decrypt(app.ring, r.secrets_enc, aad.mcpServer(OWNER, COMPOSIO_SERVER))) as { headers: Record<string, string> };
  if (headers[USER_KEY_HEADER]) return personal(app, headers[USER_KEY_HEADER], headers[ORG_HEADER]);
  return headers[KEY_HEADER] ? { headers: { [KEY_HEADER]: headers[KEY_HEADER] }, userId: USER_ID } : undefined;
}

const newSession = (app: App, c: Cred) => call<{ session_id: string; mcp: { url: string } }>(app, c.headers, "POST", "/v3.1/tool_router/session", { user_id: c.userId });

/** Checks the key by opening a session, then saves the session's MCP server for every agent. */
export async function connectComposio(app: App, apiKey: unknown): Promise<void> {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512) fail("invalid", "enter a Composio API key");
  const cred = await credOf(app, apiKey.trim());
  const s = await newSession(app, cred);
  if (typeof s?.mcp?.url !== "string") fail("failed", "Composio returned no MCP URL");
  await putMcpServer(app, COMPOSIO_SERVER, { transport: "http", url: s.mcp.url, headers: cred.headers });
}

export const disconnectComposio = (app: App) => deleteMcpServer(app, COMPOSIO_SERVER);

async function accounts(app: App, c: Cred, toolkit?: string): Promise<Account[]> {
  const q = new URLSearchParams({ user_ids: c.userId, statuses: "ACTIVE", limit: "200" });
  if (toolkit) q.set("toolkit_slugs", toolkit);
  return (await call<{ items?: Account[] }>(app, c.headers, "GET", `/v3/connected_accounts?${q}`)).items ?? [];
}

/** A personal key's connected apps, from the consumer route Composio documents for user keys (docs.composio.dev/docs/consumer-agents). */
async function consumerToolkits(app: App, c: Cred): Promise<unknown[]> {
  const q = new URLSearchParams({ user_id: c.userId });
  const r = await call<{ toolkits?: unknown }>(app, { [USER_KEY_HEADER]: c.headers[USER_KEY_HEADER]!, [ORG_HEADER]: c.headers[ORG_HEADER]! }, "GET", `/v3.1/org/consumer/connected_toolkits?${q}`);
  return Array.isArray(r?.toolkits) ? r.toolkits : [];
}

/** Whether a key is saved, and the apps signed in through it. */
export async function composioStatus(app: App): Promise<ComposioStatus> {
  const r = app.db.get<{ name: string }>("SELECT name FROM mcp_servers WHERE name = ?", COMPOSIO_SERVER);
  if (!r) return { connected: false, toolkits: [] };
  let cred: Cred | undefined;
  let slugs: unknown[];
  try {
    cred = await savedCred(app);
    if (!cred) return { connected: false, toolkits: [] };
    slugs = cred.headers[USER_KEY_HEADER] ? await consumerToolkits(app, cred) : (await accounts(app, cred)).map((a) => a.toolkit?.slug);
  } catch (e) {
    return { connected: true, toolkits: [], error: e instanceof AppFail ? e.error.message : "Composio could not be read" };
  }
  slugs = slugs.filter((s): s is string => typeof s === "string" && !!s);
  return {
    connected: true,
    toolkits: [...new Set(slugs as string[])].sort(),
    ...(cred.headers[USER_KEY_HEADER] ? { personal: true } : {}),
    ...(cred.instant === undefined ? {} : { instant: cred.instant }),
  };
}

const toolkitOf = (v: string) => (TOOLKIT.test(v) ? v : fail("invalid", "unknown app"));

async function requireCred(app: App) {
  return (await savedCred(app)) ?? fail("not_configured", "Add your Composio API key first.");
}

/** A Composio sign-in page for one app; the owner finishes it in a browser and the account shows up in `composioStatus`. */
export async function composioLink(app: App, toolkit: string): Promise<{ url: string }> {
  const cred = await requireCred(app);
  const s = await newSession(app, cred);
  const link = await call<{ redirect_url?: string }>(app, cred.headers, "POST", `/v3.1/tool_router/session/${encodeURIComponent(s.session_id)}/link`, { toolkit: toolkitOf(toolkit) });
  if (!link.redirect_url?.startsWith("https://")) fail("failed", "Composio returned no sign-in link");
  return { url: link.redirect_url };
}

/** Signs one app out: deletes its connected accounts. A personal key does this with its org and project scope, as Composio's own CLI does (`composio connections remove`). */
export async function composioUnlink(app: App, toolkit: string): Promise<void> {
  const cred = await requireCred(app);
  const slug = toolkitOf(toolkit);
  for (const a of (await accounts(app, cred, slug)).filter((x) => x.toolkit?.slug === slug)) await call(app, cred.headers, "DELETE", `/v3/connected_accounts/${encodeURIComponent(a.id)}`);
}
