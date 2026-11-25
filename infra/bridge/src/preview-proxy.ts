import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import { errTag, type Log } from "./redact";

// The preview proxy (docs/architecture.md, "Preview proxy"). A preview the agent shows (`preview_show`) is not hosted directly: the
// bridge puts a small reverse proxy in front of the dev server and the box provider hosts the proxy's port instead. The proxy
//   - adds one script tag (the overlay, `overlay/overlay.ts`) to every HTML page, so the owner's app can pick elements in a page that
//     is on another origin: the overlay answers the app over postMessage;
//   - lets the page load in a frame (drops X-Frame-Options and CSP frame-ancestors);
//   - makes every request look local to the dev server (Host, Origin and Referer say localhost:<port>, no X-Forwarded-*), so dev
//     servers that check the host (Vite's allowedHosts, Next's dev origins, server actions) work without configuration;
//   - passes WebSocket upgrades (HMR) straight through.
// It changes nothing else: bodies other than HTML pages, status codes and the other headers pass as they are.

declare const __DORKS_OVERLAY__: string | undefined;
/** The overlay bundle, inlined by scripts/build.mjs. Empty when running from source (tests). */
const OVERLAY = typeof __DORKS_OVERLAY__ === "string" ? __DORKS_OVERLAY__ : "";

export const OVERLAY_PATH = "/__dorks/overlay.js";
const TAG = `<script src="${OVERLAY_PATH}"></script>`;
/** How much of a page is held back looking for `<head>` before the tag goes in anyway. */
const SNIFF_LIMIT = 64 * 1024;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

/** The request's headers as the dev server should see them: addressed to localhost:<target>, as if opened on the box itself. */
export function upstreamHeaders(h: IncomingHttpHeaders, target: number, upgrade = false): OutgoingHttpHeaders {
  const local = `localhost:${target}`;
  const publicHosts = [h.host, h["x-forwarded-host"]].flatMap((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()) : []));
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || k.startsWith("x-forwarded-") || k === "forwarded" || (!upgrade && HOP.has(k))) continue;
    out[k] = v;
  }
  out.host = local;
  for (const k of ["origin", "referer"] as const) {
    const v = h[k];
    if (typeof v !== "string") continue;
    try {
      const u = new URL(v);
      if (!publicHosts.includes(u.host)) continue;
      u.protocol = "http:";
      u.host = local;
      out[k] = k === "origin" ? u.origin : u.href;
    } catch {
      // "null" or garbage: leave it
    }
  }
  return out;
}

/** The response's headers as the browser should see them: frameable, and redirects to the dev server's own origin made relative. */
export function downstreamHeaders(h: IncomingHttpHeaders, target: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k) || k === "x-frame-options") continue;
    out[k] = v;
  }
  for (const k of ["content-security-policy", "content-security-policy-report-only"]) {
    const v = out[k];
    if (v === undefined) continue;
    const kept = (Array.isArray(v) ? v : [String(v)])
      .map((p) =>
        p
          .split(";")
          .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
          .join(";")
          .trim(),
      )
      .filter((p) => p.replace(/;/g, "").trim());
    if (kept.length) out[k] = kept;
    else delete out[k];
  }
  const loc = out.location;
  if (typeof loc === "string") {
    try {
      const u = new URL(loc);
      const own = [`localhost:${target}`, `127.0.0.1:${target}`, `[::1]:${target}`, `0.0.0.0:${target}`];
      if (u.protocol === "http:" && own.includes(u.host)) out.location = u.pathname + u.search + u.hash;
    } catch {
      // a relative Location already points at the proxy
    }
  }
  return out;
}

/** Where the tag goes in the start of a page, or -1 to keep reading. `final`: there is no more to read. */
export function insertAt(start: string, final: boolean): number {
  const head = /<head\b[^>]*>/i.exec(start);
  if (head) return head.index + head[0].length;
  const first = /<(body|script|link|style|meta)\b/i.exec(start);
  if (first) return first.index;
  if (!final && start.length < SNIFF_LIMIT) return -1;
  const html = /<html\b[^>]*>/i.exec(start);
  return html ? html.index + html[0].length : 0;
}

/** Streams an HTML page through, with the overlay tag added once, early in `<head>` (before the app's own scripts). */
class Inject extends Transform {
  private held = "";
  private done = false;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    if (this.done) return cb(null, chunk);
    this.held += chunk.toString("latin1"); // byte for byte, whatever the page's charset
    this.tryInsert(false);
    cb();
  }
  override _flush(cb: TransformCallback) {
    if (!this.done) this.tryInsert(true);
    cb();
  }
  private tryInsert(final: boolean) {
    const at = insertAt(this.held, final);
    if (at < 0) return;
    this.push(Buffer.from(this.held.slice(0, at) + TAG + this.held.slice(at), "latin1"));
    this.held = "";
    this.done = true;
  }
}

/** A request for a page (a document or frame load), not for a fetch, an image or a script. */
function wantsPage(req: IncomingMessage) {
  if (req.method !== "GET") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document" || dest === "iframe" || dest === "frame";
  return /text\/html/.test(String(req.headers.accept ?? ""));
}

const isHtml = (res: IncomingMessage) =>
  /^text\/html\b/i.test(String(res.headers["content-type"] ?? "")) &&
  (!res.headers["content-encoding"] || res.headers["content-encoding"] === "identity") &&
  res.statusCode !== 204 &&
  res.statusCode !== 304;

const DOWN = (target: number) =>
  `<!doctype html><meta charset="utf-8"><title>Starting</title><body style="font:14px system-ui;color:#666;padding:2rem">Nothing answers on port ${target} yet. Reload once the dev server is up.`;

/** Starts a proxy for the dev server on localhost:`target`, listening on 127.0.0.1:`port` (0: any free port). */
export function startProxy(target: number, port = 0, log?: Log): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === OVERLAY_PATH || req.url?.startsWith(OVERLAY_PATH + "?")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return void res.end(OVERLAY);
    }
    const page = wantsPage(req);
    const headers = upstreamHeaders(req.headers, target);
    if (page) delete headers["accept-encoding"]; // pages come back uncompressed, so the tag can go in; nothing else changes
    // "localhost" with Node's default autoSelectFamily: a dev server on ::1 only (Vite's default on some hosts) answers as well
    const up = request({ host: "localhost", port: target, method: req.method, path: req.url, headers }, (ur) => {
      const out = downstreamHeaders(ur.headers, target);
      if (page && isHtml(ur)) {
        delete out["content-length"];
        res.writeHead(ur.statusCode ?? 502, ur.statusMessage, out);
        ur.pipe(new Inject()).pipe(res);
      } else {
        res.writeHead(ur.statusCode ?? 502, ur.statusMessage, out);
        ur.pipe(res);
      }
      ur.on("error", () => res.destroy());
    });
    up.on("error", () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page ? DOWN(target) : "");
    });
    res.on("close", () => !res.writableFinished && up.destroy());
    req.pipe(up);
  });
  // WebSockets (HMR): the handshake goes through with the same header rewrite, then bytes flow both ways untouched.
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    const up = connect({ host: "localhost", port: target, autoSelectFamily: true });
    const kill = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", kill);
    socket.on("error", kill);
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
    up.on("connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(upstreamHeaders(req.headers, target, true))) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (e) => log?.("preview proxy error:", errTag(e)));
      resolve({ port: (server.address() as AddressInfo).port, server });
    });
  });
}

type Entry = { target: number; port: number };

/**
 * The bridge's preview proxies, one per dev server port. The list is kept in the state dir: a hosted URL survives a pause, but the
 * bridge (and so every proxy) starts again on resume, so `restore` listens on the same ports again.
 */
export class PreviewProxies {
  private running = new Map<number, { port: number; server: Server }>();
  constructor(
    private file: string,
    private log: Log,
  ) {}

  /** The proxy port for the dev server on `target`, started if needed. Throws when no port can be bound. */
  async forTarget(target: number): Promise<number> {
    const have = this.running.get(target);
    if (have) return have.port;
    const p = await startProxy(target, 0, this.log);
    this.running.set(target, p);
    this.save();
    return p.port;
  }

  /** Listens again on the ports of the proxies saved before the box was paused. One that cannot be bound is dropped. */
  async restore() {
    let saved: Entry[] = [];
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(v)) saved = v.filter((e): e is Entry => Number.isInteger(e?.target) && Number.isInteger(e?.port));
    } catch {
      return;
    }
    for (const e of saved) {
      if (this.running.has(e.target)) continue;
      try {
        this.running.set(e.target, await startProxy(e.target, e.port, this.log));
      } catch (err) {
        this.log("preview proxy: could not listen again on", e.port, errTag(err));
      }
    }
    this.save();
  }

  close() {
    for (const p of this.running.values()) {
      p.server.closeAllConnections();
      p.server.close();
    }
    this.running.clear();
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify([...this.running].map(([target, p]) => ({ target, port: p.port }))), { mode: 0o600 });
    } catch (e) {
      this.log("preview proxy: could not save the list", errTag(e));
    }
  }
}
