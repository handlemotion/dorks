import { RpcError, rpcCall } from "./rpc";

// The GitHub token lives only in this process's memory. git asks for it through a credential helper (`dorks-bridge credential`) and
// the `gh` shim through the `token` RPC method (rpc.ts), both over the box user's Unix socket. Nothing is written to .git/config, the
// remote URL, or any file; a pause/resume or bridge restart simply fetches a fresh token with the next `configure`.

export class GithubToken {
  private token: string | null = null;

  constructor(private allowedHosts: string[]) {}

  set(t: string) {
    this.token = t;
  }

  get() {
    return this.token;
  }

  /** The `token` RPC method: `{ host }` → `{ token }`, only for the hosts we hold a token for. */
  rpc = (params: unknown): { token: string } => {
    const host = (params as { host?: unknown } | null)?.host;
    if (typeof host !== "string") throw new RpcError("invalid", "host must be a string");
    if (!this.allowedHosts.includes(host)) throw new RpcError("denied", "no credentials for this host");
    if (!this.token) throw new RpcError("unavailable", "the box has no GitHub token yet");
    return { token: this.token };
  };
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The value for `credential.helper`: git runs it through `sh`, appending the operation (`get`/`store`/`erase`). */
export function helperCommand(node: string, cli: string, sockPath: string) {
  return `!${shellQuote(node)} ${shellQuote(cli)} credential --sock ${shellQuote(sockPath)}`;
}

/** `dorks-bridge credential --sock <path> <get|store|erase>`: git's credential-helper protocol on stdin/stdout. */
export async function runCredentialHelper(sock: string, op: string, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
  if (op !== "get") return; // never store or erase: there is nothing on disk
  let input = "";
  for await (const c of stdin) input += c;
  const kv = Object.fromEntries(
    input
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  // Any failure (bridge gone, host not ours) is an empty answer: git then tries its next helper or fails, as with no helper at all.
  const reply = await rpcCall<{ token: string }>(sock, "token", { host: kv.host ?? "" }).catch(() => null);
  if (reply?.token) stdout.write(`username=x-access-token\npassword=${reply.token}\n`);
}
