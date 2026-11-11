import { callBackend } from "./prs";
import type { Log } from "./redact";
import { RpcError, type RpcMethods } from "./rpc";
import type { Transport } from "./transport";

// `preview.show`: the agent's dev server is up (the `preview_show` MCP tool). The backend hosts the port through the box provider and
// keeps the URL on the dork, where the owner's Previews tab lists and opens it. Nothing is stored here.

export type ShownPreview = { port: number; url: string; title?: string };

export function previewMethods(t: Transport, log: Log): RpcMethods {
  return {
    "preview.show": async (params) => {
      const p = (params ?? {}) as { port?: unknown; title?: unknown; localhost?: unknown };
      if (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new RpcError("invalid", "port must be an integer from 1 to 65535");
      const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
      return callBackend(t, log, () => t.showPreview(p.port as number, { title, localhost: p.localhost === true }), true);
    },
    // `build`: the machine_* MCP tools. The server validates everything and scopes it to this dork's build; this only forwards.
    build: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!["get", "draft", "run", "logs", "submit"].includes(p.action as string)) throw new RpcError("invalid", "unknown build action");
      return callBackend(t, log, () => t.build(p), true);
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
