import { MCP_NAME, RESERVED_MCP_NAMES, type McpServerConfig, type McpServerView } from "@dorks/shared";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { enqueueConfigure, isAwake } from "../lifecycle/dispatch";

// MCP servers from Customize (docs/mcp.md): every agent gets them through the bridge's `configure` frame, next to the built-in `dorks`
// server. Header and env values may be secrets, so they are sealed in one envelope per server and only opened for that frame.

const MAX_SERVERS = 50;
const MAX_URL = 2048;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_ENTRIES = 32;
const HEADER_NAME = /^[A-Za-z0-9_-]{1,64}$/; // HTTP token characters in practice: CONTEXT7_API_KEY has underscores
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

interface Row {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string;
  secret_names: string;
  secrets_enc: string;
  created_at: number;
}
interface Sealed {
  headers: Record<string, string>;
  env: Record<string, string>;
  /** The full URL: hosted servers often carry a key in the query or userinfo, so the `url` column keeps it redacted. */
  url?: string;
}

/** The URL without what may be a credential: userinfo and the query string become `…`. */
function redactUrl(u: URL): string {
  if (!u.username && !u.password && !u.search) return u.href;
  const auth = u.username || u.password ? "…@" : "";
  return `${u.protocol}//${auth}${u.host}${u.pathname}${u.search ? "?…" : ""}`;
}

const viewOf = (r: Row): McpServerView => {
  const names = JSON.parse(r.secret_names) as { headers: string[]; env: string[] };
  return { name: r.name, transport: r.transport, url: r.url, command: r.command, args: JSON.parse(r.args) as string[], headerNames: names.headers, envNames: names.env, createdAt: r.created_at };
};

export const listMcpServers = (app: App): McpServerView[] => app.db.all<Row>("SELECT * FROM mcp_servers ORDER BY name").map(viewOf);

const open = async (app: App, r: Row): Promise<Sealed> => JSON.parse(await decrypt(app.ring, r.secrets_enc, aad.mcpServer(OWNER, r.name))) as Sealed;

/** Every server with its values in clear, for the `configure` frame of an authenticated bridge only. */
export async function mcpServerConfigs(app: App): Promise<McpServerConfig[]> {
  const out: McpServerConfig[] = [];
  for (const r of app.db.all<Row>("SELECT * FROM mcp_servers ORDER BY name")) {
    const s = await open(app, r);
    out.push(
      r.transport === "http"
        ? { name: r.name, transport: "http", url: s.url ?? r.url ?? "", headers: s.headers }
        : { name: r.name, transport: "stdio", command: r.command ?? "", args: JSON.parse(r.args) as string[], env: s.env },
    );
  }
  return out;
}

const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string") fail("invalid", `${what} must be text`);
  const t = v.trim();
  if (!t) fail("invalid", `${what} is required`);
  if (t.length > max) fail("invalid", `${what} is too long`);
  return t;
};

/**
 * Header or env entries from the client. A `null` value keeps the saved one (so editing a URL does not ask for the token again);
 * a name left out is removed.
 */
function entries(v: unknown, saved: Record<string, string>, what: string, nameRe: RegExp): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) fail("invalid", `${what} must be an object`);
  const out: Record<string, string> = {};
  const list = Object.entries(v as Record<string, unknown>);
  if (list.length > MAX_ENTRIES) fail("invalid", `too many ${what}`);
  for (const [k, raw] of list) {
    const key = k.trim();
    if (!nameRe.test(key)) fail("invalid", `bad ${what.replace(/s$/, "")} name: ${key.slice(0, 64)}`);
    if (raw === null) {
      if (!(key in saved)) fail("invalid", `${key} has no saved value; enter one`);
      out[key] = saved[key]!;
      continue;
    }
    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_VALUE_BYTES) fail("invalid", `bad value for ${key}`);
    out[key] = raw;
  }
  return out;
}

/** The agents that are up now restart on their session with the new list, once their turn ends (as for a model change). */
function reconfigureAwake(app: App) {
  for (const { id, state } of app.db.all<{ id: string; state: string }>("SELECT id, state FROM dorks WHERE archived = 0 AND provider = 'claude'")) {
    if (!isAwake(state)) continue;
    app.db.run("DELETE FROM commands WHERE dork_id = ? AND kind = 'configure' AND acked = 0", id);
    enqueueConfigure(app, id);
  }
}

/** Adds or replaces the server `name`. Encryption happens before the write transaction. */
export async function putMcpServer(app: App, name: string, input: Record<string, unknown>): Promise<void> {
  if (!MCP_NAME.test(name)) fail("invalid", "a server name is lowercase letters, digits, - and _, starting with a letter (at most 32)");
  if (RESERVED_MCP_NAMES.includes(name)) fail("invalid", `${name} is taken by a built-in server`);
  const prev = app.db.get<Row>("SELECT * FROM mcp_servers WHERE name = ?", name);
  if (!prev && app.db.all("SELECT name FROM mcp_servers").length >= MAX_SERVERS) fail("invalid", `at most ${MAX_SERVERS} servers`);
  const saved: Sealed = prev ? await open(app, prev) : { headers: {}, env: {} };

  const transport = input.transport;
  let url: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  const sealed: Sealed = { headers: {}, env: {} };
  if (transport === "http") {
    url = str(input.url, "URL", MAX_URL);
    // The redacted URL the view showed comes back unchanged from an edit: keep the saved one.
    if (prev?.transport === "http" && url === prev.url && saved.url) url = saved.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail("invalid", "enter a full URL, like https://mcp.example.com/mcp");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail("invalid", "the URL must be http or https");
    sealed.headers = entries(input.headers, saved.headers, "headers", HEADER_NAME);
    sealed.url = url;
    url = redactUrl(parsed);
  } else if (transport === "stdio") {
    command = str(input.command, "command", 512);
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some((a) => typeof a !== "string" || a.length > 1024)) fail("invalid", "args must be a list of strings");
      args = input.args as string[];
    }
    sealed.env = entries(input.env, saved.env, "variables", ENV_NAME);
  } else fail("invalid", "transport must be http or stdio");

  const secretsEnc = (await encrypt(app.ring, JSON.stringify(sealed), aad.mcpServer(OWNER, name))).value;
  const names = JSON.stringify({ headers: Object.keys(sealed.headers).sort(), env: Object.keys(sealed.env).sort() });
  app.db.tx(() => {
    app.db.run(
      `INSERT INTO mcp_servers (name, transport, url, command, args, secret_names, secrets_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET transport = excluded.transport, url = excluded.url, command = excluded.command, args = excluded.args,
         secret_names = excluded.secret_names, secrets_enc = excluded.secrets_enc`,
      name,
      transport as string,
      url,
      command,
      JSON.stringify(args),
      names,
      secretsEnc,
      app.now(),
    );
    reconfigureAwake(app);
    touch(app, { t: "settings" });
  });
}

export function deleteMcpServer(app: App, name: string): void {
  app.db.tx(() => {
    if (!app.db.get("SELECT name FROM mcp_servers WHERE name = ?", name)) return;
    app.db.run("DELETE FROM mcp_servers WHERE name = ?", name);
    reconfigureAwake(app);
    touch(app, { t: "settings" });
  });
}
