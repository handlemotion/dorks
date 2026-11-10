import type { PrRef, SubscriptionView } from "@dorks/shared";
import { createInterface } from "node:readline";
import { describeRpcError, listLine, socketOf } from "./dorks";
import { parsePrRef, prLabel, samePr } from "./pr-ref";
import type { ShownPreview } from "./previews";
import { rpcCall } from "./rpc";

// `dorks mcp`: the same agent surface as `dorks pr …`, as MCP tools (Model Context Protocol) so the agent calls them as typed tools
// instead of shelling out. It is a stdio MCP server: Claude Code starts it from the bridge-written `mcp.json` (hooks.ts `claudeMcpConfig`,
// passed as `claude --mcp-config`), speaks newline-delimited JSON-RPC 2.0 to it, and it forwards every call to the running bridge on
// DORKS_SOCK. Nothing here holds state or a credential; the backend stays the single owner of the truth.
//
// Hand-rolled on purpose: the bridge ships as one dependency-light bundle and the server needs four methods (initialize, ping,
// tools/list, tools/call), so the MCP SDK would only add weight to every box snapshot.

/** The server name; Claude Code prefixes the tools with it, so the agent sees `mcp__dorks__pr_subscribe`. */
export const MCP_SERVER_NAME = "dorks";
/** Versions we can speak. A client asking for another one is answered with the newest, as the spec requires. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PR_PARAM = { type: "string", description: "The pull request: a URL like https://github.com/owner/name/pull/12, or owner/name#12." } as const;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>, sock: string) => Promise<string>;
}

/** Thrown by a tool for a problem the agent should read and act on; it becomes a tool result with `isError`, not a protocol error. */
class ToolError extends Error {}

function prArg(args: Record<string, unknown>): PrRef {
  const ref = typeof args.pr === "string" ? parsePrRef(args.pr) : null;
  if (!ref) throw new ToolError("`pr` must be a pull request URL (https://github.com/owner/name/pull/12) or owner/name#12.");
  return ref;
}

const TOOLS: Tool[] = [
  {
    name: "pr_subscribe",
    title: "Subscribe to a pull request",
    description:
      "Get woken up when something happens on a pull request: CI fails or passes, a review or comment arrives, a merge conflict appears, or it is merged or closed. " +
      "`gh pr create` already subscribes you to the PRs you open, so use this for a PR someone else opened or one you were pointed at. Idempotent.",
    inputSchema: { type: "object", properties: { pr: PR_PARAM }, required: ["pr"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const ref = prArg(args);
      await rpcCall(sock, "pr.sub", { ...ref, source: "agent" });
      return `Subscribed to ${prLabel(ref)}. Notifications about it arrive as <dorks-event> turns.`;
    },
  },
  {
    name: "pr_unsubscribe",
    title: "Unsubscribe from a pull request",
    description: "Stop being notified about a pull request. Use it when you are done with a PR or it is being handled elsewhere. Merged and closed PRs end by themselves.",
    inputSchema: { type: "object", properties: { pr: PR_PARAM }, required: ["pr"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const ref = prArg(args);
      await rpcCall(sock, "pr.unsub", ref);
      return `Unsubscribed from ${prLabel(ref)}.`;
    },
  },
  {
    name: "pr_list",
    title: "List subscribed pull requests",
    description:
      "The pull requests you are subscribed to, with CI, review and mergeability state and how many CI fix attempts are used. A STALLED PR needs a human: do not keep retrying it. " +
      "Pass `pr` to look at one of them.",
    inputSchema: { type: "object", properties: { pr: { ...PR_PARAM, description: "Optional: only this pull request. " + PR_PARAM.description } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const only = args.pr === undefined ? null : prArg(args);
      const all = await rpcCall<SubscriptionView[]>(sock, "pr.list");
      const subs = only ? all.filter((s) => samePr(s, only)) : all;
      if (only && !subs.length) return `You are not subscribed to ${prLabel(only)}.`;
      return subs.length ? subs.map(listLine).join("\n") : "No PR subscriptions.";
    },
  },
  {
    name: "preview_show",
    title: "Show a dev server to the user",
    description:
      "Open a web server running in this box in the user's Previews tab, so they can see and click through it. Call it once the server answers " +
      "(e.g. `curl -sI localhost:3000`), and again after restarting it on another port. Start servers on 0.0.0.0 when you can " +
      "(`--host 0.0.0.0`); pass `localhost: true` only for one that listens on 127.0.0.1 alone. The page is served from an *.on.boat.dev " +
      "host: Vite needs `server.allowedHosts: true` (or `.on.boat.dev`). Not for ports 22, 6080, 8090, 8911 or 47984-48010. " +
      "The returned URL is public while the box runs: do not show servers that expose secrets.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "The port the server listens on, e.g. 3000." },
        title: { type: "string", description: "Optional: a short name for the list, e.g. \"Web app\". Defaults to the port." },
        localhost: { type: "boolean", description: "Optional: true when the server listens only on 127.0.0.1 or ::1." },
      },
      required: ["port"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    async run(args, sock) {
      const port = args.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError("`port` must be an integer from 1 to 65535.");
      if (args.title !== undefined && typeof args.title !== "string") throw new ToolError("`title` must be a string.");
      const shown = await rpcCall<ShownPreview>(sock, "preview.show", { port, title: args.title, localhost: args.localhost === true });
      return `Showing port ${shown.port} in the user's Previews tab at ${shown.url}. If the page is blank or errors, check that the server answers on that port.`;
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

type Id = string | number | null;
interface Request {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export class McpServer {
  constructor(private env: NodeJS.ProcessEnv) {}

  /** One incoming message. Returns the reply, or null for notifications (which are never answered). */
  async handle(line: string): Promise<object | null> {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return err(null, -32700, "parse error");
    }
    if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") return err(null, -32600, "invalid request");
    const isNotification = !("id" in req);
    const id = req.id ?? null;
    const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
    let reply: object;
    switch (req.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        reply = ok(id, {
          protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "Dorks", version: "0.1.0" },
          instructions:
            "Tools for the pull requests you work on in this box, and for showing the user a dev server. `gh pr create` subscribes you automatically; subscribed PRs wake you with <dorks-event> turns when CI, reviews, comments or conflicts need you. " +
            "When you start a web server the user should see, call preview_show with its port.",
        });
        break;
      }
      case "ping":
        reply = ok(id, {});
        break;
      case "tools/list":
        reply = ok(id, { tools: TOOLS.map(({ run: _run, ...t }) => t) });
        break;
      case "tools/call":
        reply = ok(id, await this.call(params.name, params.arguments));
        break;
      default:
        reply = err(id, -32601, "method not found");
    }
    return isNotification ? null : reply;
  }

  private async call(name: unknown, args: unknown) {
    const tool = typeof name === "string" ? byName.get(name) : undefined;
    const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });
    if (!tool) return result(`Unknown tool "${String(name)}".`, true);
    const sock = socketOf(this.env);
    if (!sock) return result("This only works inside a dork box (DORKS_SOCK is not set).", true);
    try {
      return result(await tool.run(args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}, sock));
    } catch (e) {
      return result(e instanceof ToolError ? e.message : describeRpcError(e), true);
    }
  }
}

/** Serves one MCP session on a stream pair until the input ends (Claude Code closes our stdin when it exits). */
export function serveMcp(env: NodeJS.ProcessEnv, input: NodeJS.ReadableStream, write: (s: string) => void): Promise<void> {
  const server = new McpServer(env);
  let chain: Promise<unknown> = Promise.resolve(); // answered in arrival order
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      const reply = await server.handle(line).catch(() => err(null, -32603, "internal error"));
      if (reply) write(JSON.stringify(reply) + "\n");
    });
  });
  return new Promise((resolve) => rl.on("close", () => void chain.then(() => resolve())));
}
