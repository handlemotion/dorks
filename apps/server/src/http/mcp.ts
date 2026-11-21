import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { crewToolsFor, renderCrew } from "@dorks/shared";
import { AppFail, type App } from "../app";
import { crewCall } from "../services/crew";

// The dorks server as an MCP server for the owner's other agents (docs/crew.md): Claude Code, Claude Desktop, Cursor, Devin or a
// script can start dorks, message them, wait for them and read their answers. Streamable HTTP on one endpoint, `POST /mcp` on the
// loopback UI listener, answered with plain JSON (no SSE: nothing here streams progress). Stateless as in MCP 2026-07-28: sessions are
// named by `id` arguments, no `Mcp-Session-Id` is minted. Clients that still open with `initialize` (2025-11-25 and older) get the
// handshake answer they expect. Auth is the owner token, the same bearer as the UI API.

export const MCP_PATH = "/mcp";
const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "dorks", title: "Dorks", version: "0.1.0" };
const INSTRUCTIONS =
  "Dorks runs coding agents (dorks), each in its own cloud sandbox on its own branch, that open and follow pull requests. " +
  "Start one with dork_create (a self-contained task and a repo from repo_list), then dork_wait for it to settle and dork_get for its final answer; " +
  "steer it with dork_send. For a long goal, start a coordinator (dork_create with coordinator: true): it breaks the goal down and runs worker dorks itself.";

type Id = string | number | null;
type Msg = { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown };
const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const tokenOk = (presented: string | undefined, owner: string) => {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(owner);
  return a.length === b.length && timingSafeEqual(a, b);
};

const TOOLS = crewToolsFor("owner").map(({ audience: _a, ...t }) => t);

async function callTool(app: App, params: Record<string, unknown>) {
  try {
    const r = await crewCall(app, { owner: true }, params.name, params.arguments);
    return { content: [{ type: "text", text: renderCrew(r, app.now()) }], structuredContent: r, isError: false };
  } catch (e) {
    if (e instanceof AppFail) return { content: [{ type: "text", text: e.error.message }], isError: true };
    console.error("mcp tool failed", typeof params.name === "string" ? params.name : "?", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return { content: [{ type: "text", text: "Something went wrong on the dorks server." }], isError: true };
  }
}

const negotiate = (asked: unknown) => (typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0]);

const METHODS: Record<string, (app: App, p: Record<string, unknown>) => unknown> = {
  // Legacy handshake (2025-11-25 and older). No session id: every call stands on its own.
  initialize: (_app, p) => ({ protocolVersion: negotiate(p.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }),
  // 2026-07-28: what the server speaks, without a handshake.
  "server/discover": () => ({ supportedVersions: VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }),
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  "tools/call": (app, p) => callTool(app, p),
};

async function handle(app: App, m: Msg): Promise<object | null> {
  if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.method !== "string") return err(null, -32600, "invalid request");
  const notification = !("id" in m);
  const id = m.id ?? null;
  const method = Object.hasOwn(METHODS, m.method) ? METHODS[m.method] : undefined;
  if (notification) return null; // notifications/initialized, notifications/cancelled: nothing to answer
  if (!method) return err(id, -32601, "method not found");
  const params = m.params && typeof m.params === "object" ? (m.params as Record<string, unknown>) : {};
  return ok(id, await method(app, params));
}

const reject = (c: Context, status: 400 | 401 | 403 | 405, message: string, headers: Record<string, string> = {}) => c.json(err(null, -32600, message), status, headers);

/** Adds `POST /mcp` (and its 405s) to the UI listener's app. It sits outside `/api`, so it checks the owner token itself. */
export function mountMcp(api: Hono, app: App) {
  api.post(MCP_PATH, async (c) => {
    // DNS rebinding: a page in the owner's browser must not reach this. Non-browser clients send no Origin.
    const origin = c.req.header("origin");
    if (origin && !app.cfg.uiOrigins.includes(origin)) return reject(c, 403, "origin not allowed");
    const auth = c.req.header("authorization");
    if (!tokenOk(auth?.startsWith("Bearer ") ? auth.slice(7) : undefined, app.cfg.ownerToken)) return reject(c, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
    const version = c.req.header("mcp-protocol-version");
    if (version && !VERSIONS.includes(version)) return reject(c, 400, `unsupported protocol version ${version}; this server speaks ${VERSIONS.join(", ")}`);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err(null, -32700, "parse error"), 400);
    }
    const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handle(app, m as Msg)))).filter((r) => r !== null);
    if (!replies.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? replies : replies[0]);
  });
  const notAllowed = (c: Context) => c.body(null, 405, { Allow: "POST" });
  api.get(MCP_PATH, notAllowed);
  api.delete(MCP_PATH, notAllowed);
}
