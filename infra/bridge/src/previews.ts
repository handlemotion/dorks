import type { CrewRole, DorkMode } from "@dorks/shared";
import { callBackend } from "./prs";
import type { PreviewProxies } from "./preview-proxy";
import { errTag, type Log } from "./redact";
import { RpcError, type RpcMethods } from "./rpc";
import type { Transport } from "./transport";

// `preview.show`: the agent's dev server is up (the `preview_show` MCP tool). The bridge puts its preview proxy in front of the port
// (preview-proxy.ts: the page gets the element picker's overlay and loads in a frame), the backend hosts the proxy's port through the
// box provider and keeps the URL on the dork, where the owner's Artifacts shows it as a running preview.

export type ShownPreview = { port: number; url: string; title?: string };

/** Ports the box provider uses itself (Boat: SSH, the desktop stream, its agents); the server refuses them too. */
const reserved = (port: number) => [22, 6080, 8090, 8911].includes(port) || (port >= 47984 && port <= 48010);

export function previewMethods(
  t: Transport,
  log: Log,
  crew: () => { role: CrewRole | null; mode: DorkMode } = () => ({ role: null, mode: "code" }),
  proxies?: PreviewProxies,
  bridgePort?: number,
): RpcMethods {
  return {
    // `crew.role`: which crew tools (docs/crew.md) and which mode's tools (docs/modes.md) the in-box MCP server lists. Answered here
    // from the last configure.
    "crew.role": () => crew(),
    // `crew`: a crew tool call. The server checks the tool against this dork's role and scopes every id to its crew; this only forwards.
    crew: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (typeof p.tool !== "string") throw new RpcError("invalid", "tool is required");
      return callBackend(t, log, () => t.crew({ tool: p.tool, args: p.args ?? {} }), true);
    },
    "preview.show": async (params) => {
      const p = (params ?? {}) as { port?: unknown; title?: unknown; localhost?: unknown };
      if (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new RpcError("invalid", "port must be an integer from 1 to 65535");
      const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
      const port = p.port;
      let via: number | undefined;
      if (proxies && !reserved(port) && port !== bridgePort) {
        try {
          via = await proxies.forTarget(port);
        } catch (e) {
          log("preview proxy failed, hosting the port directly:", errTag(e)); // the preview still works, without the picker
        }
      }
      return callBackend(t, log, () => t.showPreview(port, { title, localhost: p.localhost === true, ...(via ? { via } : {}) }), true);
    },
    // `comment`: the comment_* MCP tools. The server checks everything and scopes it to this dork; this only forwards.
    comment: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!["list", "reply", "resolve"].includes(p.action as string)) throw new RpcError("invalid", "unknown comment action");
      return callBackend(t, log, () => t.comment(p), true);
    },
    // `ship`: the ship_verify MCP tool. The server finds the ship waiting for a check and records it; this only forwards.
    ship: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (p.action !== "verify") throw new RpcError("invalid", "unknown ship action");
      return callBackend(t, log, () => t.ship(p), true);
    },
    // `telemetry`: the telemetry_query MCP tool. The server forces this box's own Sentry environment; this only forwards.
    telemetry: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!["errors", "spans", "p95", "usage"].includes(p.kind as string)) throw new RpcError("invalid", "kind must be errors, spans, p95 or usage");
      return callBackend(t, log, () => t.telemetry(p), true);
    },
    // `prodlike`: the A/B run's calls (prodlike.ts). The server checks the run is this box's, compares and posts the check.
    prodlike: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!["start", "report", "get"].includes(p.action as string)) throw new RpcError("invalid", "unknown prodlike action");
      return callBackend(t, log, () => t.prodlike(p), true);
    },
    // `build`: the machine_* MCP tools. The server validates everything and scopes it to this dork's build; this only forwards.
    build: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!["get", "draft", "run", "logs", "submit"].includes(p.action as string)) throw new RpcError("invalid", "unknown build action");
      return callBackend(t, log, () => t.build(p), true);
    },
    // `local`: the local_* MCP tools (docs/local-access.md). The owner decides in the app; the server checks and runs everything.
    local: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (p.action !== "request" && p.action !== "wait") throw new RpcError("invalid", "unknown local action");
      return callBackend(t, log, () => t.local(p), true);
    },
    // `image.share`: a screenshot from the `screenshot_share` MCP tool, already read and checked in the agent's process.
    "image.share": async (params) => {
      const p = (params ?? {}) as { data?: unknown; caption?: unknown };
      if (typeof p.data !== "string" || !p.data) throw new RpcError("invalid", "data must be a base64 image");
      const caption = typeof p.caption === "string" && p.caption.trim() ? p.caption.trim() : undefined;
      return callBackend(t, log, () => t.shareImage(p.data as string, caption), true);
    },
  };
}
