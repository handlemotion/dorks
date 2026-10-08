import { chmodSync, chownSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

// The bridge's local RPC: JSON lines over a Unix socket owned by the box user (0600, inside a 0700 dir), so only processes of the user
// that runs Claude can call it. One request per line, answered in order on the same connection:
//   -> {"method":"pr.sub","params":{…}}
//   <- {"ok":true,"result":…}   |   {"ok":false,"error":{"code":"invalid","message":"…"}}
// Clients: the git credential helper, the `dorks` CLI, the `gh` shim and (next) the Claude Code hooks. Methods are a plain table,
// so a new caller only needs a new entry (see Bridge.rpcMethods).

/** Server-side codes are the first five; `unreachable` and `protocol` are produced by {@link rpcCall} itself. */
export type RpcErrorCode = "invalid" | "unknown_method" | "unavailable" | "denied" | "failed" | "unreachable" | "protocol";

export class RpcError extends Error {
  constructor(readonly code: RpcErrorCode, message: string) {
    super(message);
  }
}

export type RpcMethods = Record<string, (params: unknown) => unknown | Promise<unknown>>;

/** A request line above this is dropped with the connection (hook payloads carry tool output, so it is generous). */
const MAX_LINE = 1024 * 1024;

export class RpcServer {
  private server: Server | null = null;

  /** `owner`: the unprivileged user that runs git/claude (CLAUDE_RUN_AS); the socket and its dir belong to them so only they can call. */
  constructor(readonly sockPath: string, private methods: RpcMethods, private owner?: { uid: number; gid: number } | null) {}

  async start() {
    mkdirSync(dirname(this.sockPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.sockPath), 0o700);
    if (this.owner) chownSync(dirname(this.sockPath), this.owner.uid, this.owner.gid);
    rmSync(this.sockPath, { force: true }); // stale socket from a killed bridge
    this.server = createServer({ allowHalfOpen: true }, (sock) => this.serve(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.sockPath, () => res());
    });
    chmodSync(this.sockPath, 0o600);
    if (this.owner) chownSync(this.sockPath, this.owner.uid, this.owner.gid);
  }

  close() {
    this.server?.close();
    rmSync(this.sockPath, { force: true });
  }

  private serve(sock: Socket) {
    let buf = "";
    let chain: Promise<unknown> = Promise.resolve();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        chain = chain.then(async () => {
          const reply = await this.handle(line);
          if (!sock.destroyed) sock.write(JSON.stringify(reply) + "\n");
        });
      }
      if (buf.length > MAX_LINE) sock.destroy();
    });
    // the client half-closes after its last request: answer what is queued, then close
    sock.on("end", () => void chain.then(() => sock.end()));
  }

  private async handle(line: string) {
    let req: { method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return fail("invalid", "request is not JSON");
    }
    const handler = typeof req?.method === "string" && Object.hasOwn(this.methods, req.method) ? this.methods[req.method] : undefined;
    if (!handler) return fail("unknown_method", "unknown method");
    try {
      return { ok: true, result: (await handler(req.params ?? {})) ?? null };
    } catch (e) {
      // only RpcError messages are meant for the caller; anything else may echo configuration
      return e instanceof RpcError ? fail(e.code, e.message) : fail("failed", "internal error");
    }
  }
}

const fail = (code: RpcErrorCode, message: string) => ({ ok: false, error: { code, message } });

/** One call on a fresh connection. Rejects with {@link RpcError}; `unreachable` when nothing is listening (no bridge, or not our box). */
export function rpcCall<T = unknown>(sock: string, method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = connect(sock);
    let out = "";
    let settled = false;
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      f();
    };
    const timer = setTimeout(() => done(() => reject(new RpcError("unreachable", "the bridge did not answer in time"))), timeoutMs);
    s.setEncoding("utf8");
    s.on("connect", () => s.end(JSON.stringify({ method, params }) + "\n"));
    s.on("data", (d: string) => (out += d));
    s.on("error", () => done(() => reject(new RpcError("unreachable", "cannot reach the dorks bridge"))));
    s.on("close", () =>
      done(() => {
        try {
          const r = JSON.parse(out);
          if (r?.ok === true) return resolve(r.result as T);
          if (r?.ok === false && typeof r.error?.code === "string") return reject(new RpcError(r.error.code, String(r.error.message ?? "")));
        } catch {
          /* falls through */
        }
        reject(new RpcError("protocol", "the bridge sent an unreadable reply"));
      }),
    );
  });
}
