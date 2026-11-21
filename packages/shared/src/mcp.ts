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
  z.object({
    name: z.string(),
    transport: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    /** Signed in with OAuth (docs/mcp.md, "OAuth"): the bridge proxies it and asks the server for a fresh token (`mcp_token`). */
    oauth: z.boolean().optional(),
  }),
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
  /**
   * OAuth (docs/mcp.md): `signed_out` when the server asked for a sign-in (it answered 401 with OAuth metadata) and has no tokens,
   * `signed_in` once the owner signed in; null for a server that needs none.
   */
  oauth: McpOAuthState | null;
  createdAt: number;
}

export type McpOAuthState = "signed_in" | "signed_out";

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
  /** The saved key is a personal user key (`uak_…`, Composio's For You), acting in the owner's own consumer project. */
  personal?: boolean;
  /** For a personal key: whether Composio Instant is on, so agents can use tools such as web search billed to the account's credits. */
  instant?: boolean;
  /** Why the apps could not be read (a revoked key, Composio down); the key can still be replaced or removed. */
  error?: string;
}
