import type { PrRef, SubscriptionView } from "@dorks/shared";
import { parsePrRef, prLabel } from "./pr-ref";
import { runHook } from "./hook-cli";
import { RpcError, rpcCall } from "./rpc";

// `dorks`: the agent-facing CLI. It is the bridge binary run under another name (see cli.ts) and talks to the running bridge over the
// local RPC socket (DORKS_SOCK, set in the Claude child's environment).

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface DorksIo extends Io {
  /** All of stdin (only `dorks hook` reads it). */
  readInput: () => Promise<string>;
}

const USAGE = `usage:
  dorks pr sub <pr>        get notified about CI, reviews, comments and conflicts on a PR
  dorks pr unsub <pr>      stop being notified about a PR
  dorks pr list [--json]   the PRs this dork is subscribed to
  dorks hook <event>       (run by Claude Code, not by hand) stop | post-tool-use | session-start
<pr> is https://github.com/owner/name/pull/12 or owner/name#12`;

/** The socket path for a client of the bridge's RPC, or null when this process is not inside a dork box. */
export const socketOf = (env: NodeJS.ProcessEnv) => env.DORKS_SOCK || null;

export const describeRpcError = (e: unknown) => (e instanceof RpcError ? (e.code === "unreachable" ? "cannot reach the dorks bridge in this box" : e.message) : "unexpected error");

function listLine(s: SubscriptionView) {
  const parts = [`ci ${s.ci}`, `review ${s.review}`, s.mergeable === false ? "has conflicts" : s.mergeable === true ? "mergeable" : "mergeability unknown"];
  if (s.status === "stalled") parts.push("STALLED (needs a human)");
  else if (s.ciFixAttempts > 0) parts.push(`ci fix attempts ${s.ciFixAttempts}`);
  return `${prLabel(s)}  ${s.state}  ${parts.join(", ")}${s.title ? `  ${s.title}` : ""}\n  ${s.url}`;
}

export async function runDorks(argv: string[], env: NodeJS.ProcessEnv, io: DorksIo): Promise<number> {
  const [group, verb, ...rest] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    (group ? io.out : io.err)(USAGE + "\n");
    return group ? 0 : 2;
  }
  if (group === "hook") return runHook(verb, env, io.readInput, io.out);
  if (group !== "pr" || !["sub", "unsub", "list"].includes(verb ?? "")) {
    io.err(`dorks: unknown command "${argv.slice(0, 2).join(" ")}"\n${USAGE}\n`);
    return 2;
  }

  let ref: PrRef | null = null;
  const json = rest.includes("--json");
  if (verb === "list") {
    if (rest.some((a) => a !== "--json")) {
      io.err(`dorks: unexpected argument\n${USAGE}\n`);
      return 2;
    }
  } else {
    ref = rest.length === 1 ? parsePrRef(rest[0]!) : null;
    if (!ref) {
      io.err(`dorks: expected one PR reference: https://github.com/owner/name/pull/12 or owner/name#12\n`);
      return 2;
    }
  }

  const sock = socketOf(env);
  if (!sock) {
    io.err("dorks: DORKS_SOCK is not set; this only works inside a dork box\n");
    return 1;
  }
  try {
    if (verb === "list") {
      const subs = await rpcCall<SubscriptionView[]>(sock, "pr.list");
      io.out(json ? JSON.stringify(subs, null, 2) + "\n" : subs.length ? subs.map(listLine).join("\n") + "\n" : "No PR subscriptions.\n");
    } else {
      await rpcCall(sock, verb === "sub" ? "pr.sub" : "pr.unsub", verb === "sub" ? { ...ref, source: "agent" } : ref);
      io.out(`${verb === "sub" ? "Subscribed to" : "Unsubscribed from"} ${prLabel(ref!)}\n`);
    }
    return 0;
  } catch (e) {
    io.err(`dorks: ${describeRpcError(e)}\n`);
    return 1;
  }
}
