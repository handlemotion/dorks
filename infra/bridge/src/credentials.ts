import { chmodSync, chownSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { dirname } from "node:path";

// The GitHub token lives only in this process's memory. git asks for it through a credential helper (`dorks-bridge credential`),
// which fetches it over a Unix socket owned by the box user (0600, inside a 0700 dir). Nothing is written to .git/config, the
// remote URL, or any file; a pause/resume or bridge restart simply fetches a fresh token with the next `configure`.

export class CredentialServer {
  private token: string | null = null;
  private server: Server | null = null;

  /** `owner`: the unprivileged user that runs git/claude (CLAUDE_RUN_AS); the socket and its dir belong to them so only they can ask. */
  constructor(readonly sockPath: string, private allowedHosts: string[], private owner?: { uid: number; gid: number } | null) {}

  setToken(t: string) {
    this.token = t;
  }

  async start() {
    mkdirSync(dirname(this.sockPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.sockPath), 0o700);
    if (this.owner) chownSync(dirname(this.sockPath), this.owner.uid, this.owner.gid);
    rmSync(this.sockPath, { force: true }); // stale socket from a killed bridge
    this.server = createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (d: string) => {
        buf += d;
        const nl = buf.indexOf("\n");
        if (nl < 0 || buf.length > 4096) return void (buf.length > 4096 && sock.destroy());
        let host = "";
        try {
          host = String(JSON.parse(buf.slice(0, nl)).host ?? "");
        } catch {
          /* empty reply below */
        }
        const ok = this.token && this.allowedHosts.includes(host);
        sock.end(JSON.stringify(ok ? { username: "x-access-token", password: this.token } : {}) + "\n");
      });
    });
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
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The value for `credential.helper`: git runs it through `sh`, appending the operation (`get`/`store`/`erase`). */
export function helperCommand(node: string, cli: string, sockPath: string) {
  return `!${q(node)} ${q(cli)} credential --sock ${q(sockPath)}`;
}

/** `dorks-bridge credential --sock <path> <get|store|erase>`: git's credential-helper protocol on stdin/stdout. */
export async function runCredentialHelper(sock: string, op: string, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
  if (op !== "get") return; // never store or erase: there is nothing on disk
  let input = "";
  for await (const c of stdin) input += c;
  const kv = Object.fromEntries(input.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const reply = await new Promise<{ username?: string; password?: string }>((resolve) => {
    const s = connect(sock);
    let out = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(JSON.stringify({ host: kv.host, protocol: kv.protocol }) + "\n"));
    s.on("data", (d: string) => (out += d));
    s.on("end", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({});
      }
    });
    s.on("error", () => resolve({}));
  });
  if (reply.username && reply.password) stdout.write(`username=${reply.username}\npassword=${reply.password}\n`);
}
