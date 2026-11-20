import { z } from "zod";

// MCP servers the owner adds in Customize (docs/mcp.md). Every agent gets them, in every sandbox, next to the built-in `dorks` server.
// A remote server is `http` (Streamable HTTP, what hosted servers such as Composio, Linear or Sentry speak); a local one is `stdio`, a
// command the sandbox runs (`npx -y some-mcp-server`). Header and env values may be secrets: they are stored encrypted, travel only in
// the authenticated `configure` frame, and are never shown again.

/** Claude Code prefixes a server's tools with its name (`mcp__<name>__<tool>`), so keep it short and plain. */
export const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Names the sandbox already uses: our own server and Boat's computer-use server. */
export const RESERVED_MCP_NAMES = ["dorks", "computer"];

export const mcpServerConfig = z.discriminatedUnion("transport", [
  z.object({ name: z.string(), transport: z.literal("http"), url: z.string(), headers: z.record(z.string(), z.string()) }),
  z.object({ name: z.string(), transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
]);
/** A server as the bridge receives it: values in clear, for the agent only. */
export type McpServerConfig = z.infer<typeof mcpServerConfig>;

/** A server as a client sees it: the secret values replaced by their names. */
export interface McpServerView {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  headerNames: string[];
  envNames: string[];
  createdAt: number;
}

/**
 * What a client sends to add or replace a server. On a replace, a header or env entry whose value is `null` keeps its saved value,
 * so the UI can edit a URL without asking for the token again; leaving a name out removes it.
 */
export interface McpServerInput {
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string | null>;
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
}

/** Composio (docs/mcp.md): whether its key is saved, and the toolkit slugs (`figma`, `gmail`…) signed in through it. */
export interface ComposioStatus {
  connected: boolean;
  toolkits: string[];
}
