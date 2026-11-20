import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { Log } from "./redact";

// The owner's OAuth MCP servers (docs/mcp.md, "OAuth") reach the agent through this loopback proxy. Access tokens expire (often
// within the hour) and the refresh token never leaves the dorks server, so the agent's config points here instead of at the server,
// and each request goes out with a current `Authorization` that the bridge asks the backend for (`mcp_token`). A 401 from the server
// gets one retry with a refreshed token. Everything else (Streamable HTTP's POST and GET, SSE responses, `Mcp-Session-Id`) passes through.

export interface ProxyRoute {
  url: string;
  /** The server's other saved headers, added to every request. */
  headers: Record<string, string>;
}
export type TokenSource = (name: string, stale?: string) => Promise<{ authorization: string; expiresAt: number | null }>;

const MAX_BODY = 16 * 1024 * 1024;
const MARGIN_MS = 60_000;
/** Request headers that belong to this hop, or that we set ourselves. */
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "te",
  "upgrade",
  "authorization",
  "accept-encoding",
  "proxy-authorization",
  "proxy-connection",
]);
/** Response headers that no longer hold once fetch has decoded the body and we re-stream it. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "content-length", "content-encoding", "transfer-encoding"]);

export class McpOAuthProxy {
  private server: Server | null = null;
  private port = 0;
  /** Only the agent's config knows the path: another local user cannot borrow the owner's sign-in. */
  private readonly secret = randomBytes(16).toString("hex");
  private routes = new Map<string, ProxyRoute>();
  private tokens = new Map<string, { authorization: string; expiresAt: number | null }>();

  constructor(
    private readonly token: TokenSource,
    private readonly log: Log,
    private readonly onToken: (value: string) => void = () => {},
    private readonly doFetch: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
  }

  close() {
    this.server?.close();
    this.server = null;
  }

  /** The URL the agent's config gives for `name`. */
  urlFor(name: string): string {
    return `http://127.0.0.1:${this.port}/${this.secret}/${encodeURIComponent(name)}`;
  }

  /** The servers proxied now; a token cached for one that is gone is dropped. */
  set(routes: Map<string, ProxyRoute>) {
    this.routes = routes;
    for (const name of this.tokens.keys()) if (!routes.has(name)) this.tokens.delete(name);
  }

  private async current(name: string, stale?: string) {
    const cached = this.tokens.get(name);
    if (!stale && cached && (cached.expiresAt === null || cached.expiresAt - MARGIN_MS > this.now())) return cached.authorization;
    const t = await this.token(name, stale?.replace(/^Bearer /, ""));
    this.onToken(t.authorization.replace(/^Bearer /, ""));
    this.tokens.set(name, t);
    return t.authorization;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://proxy");
    const [, secret, rawName, ...rest] = url.pathname.split("/");
    const name = decodeURIComponent(rawName ?? "");
    const route = secret === this.secret && rest.length === 0 ? this.routes.get(name) : undefined;
    if (!route) return end(res, 404, "not found");

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    if (body === null) return end(res, 413, "request too large");
    const headers = forwardHeaders(req, route);
    const target = new URL(route.url);
    url.searchParams.forEach((v, k) => target.searchParams.append(k, v));

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = (authorization: string) => this.doFetch(target, { method: req.method, headers: { ...headers, authorization }, body, signal: abort.signal, redirect: "manual" });
    let upstream: Response;
    try {
      let auth = await this.current(name);
      upstream = await send(auth);
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        auth = await this.current(name, auth);
        upstream = await send(auth);
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      const why = e instanceof Error && /sign in/i.test(e.message) ? e.message : `${name} could not be reached`;
      this.log(`mcp proxy: ${name}: ${why}`);
      return end(res, 502, why);
    }
    relay(upstream, res);
  }
}

/** The request body, buffered for a possible retry (MCP messages are small); null past the limit. */
async function readBody(req: IncomingMessage): Promise<ArrayBuffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  const all = Buffer.concat(chunks);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

/** The agent's headers minus this hop's, plus the server's saved ones. */
function forwardHeaders(req: IncomingMessage, route: ProxyRoute): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQUEST.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  return Object.assign(headers, route.headers, { "accept-encoding": "identity" });
}

/** Streams the server's answer back as it comes (an SSE stream stays open). */
function relay(upstream: Response, res: ServerResponse) {
  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (!upstream.body) return void res.end();
  const stream = Readable.fromWeb(upstream.body as WebStream<Uint8Array>);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** A JSON-RPC style error, so the agent's MCP client shows the reason (a sign-in to redo, say) instead of a bare status. */
function end(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}
