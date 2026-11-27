import type { PrRef, SubscriptionView } from "@dorks/shared";
import { parsePrRef, prLabel } from "./pr-ref";
import { runHook } from "./hook-cli";
import { RpcError, rpcCall } from "./rpc";
import { describeAb, describeTelemetry, PlanError, runAb } from "./prodlike";

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
  dorks mcp                (run by Claude Code, not by hand) the same PR tools as an MCP server
  dorks telemetry [errors|spans|p95|usage] [--route R] [--op O] [--since 1h] [--half base|head] [--json]
                           this box's own Sentry telemetry (Twin Engine)
  dorks prodlike run [--rounds N] [--requests N] [--base REF]
                           A/B the PR's base and head on this box; posts the Dorks / Twin Engine check
<pr> is https://github.com/owner/name/pull/12 or owner/name#12`;

/** The socket path for a client of the bridge's RPC, or null when this process is not inside a dork box. */
export const socketOf = (env: NodeJS.ProcessEnv) => env.DORKS_SOCK || null;

export const describeRpcError = (e: unknown) => (e instanceof RpcError ? (e.code === "unreachable" ? "cannot reach the dorks bridge in this box" : e.message) : "unexpected error");

export function listLine(s: SubscriptionView) {
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
  if (group === "telemetry" || group === "prodlike") return runProdlike(group, verb, rest, env, io);
  if (group !== "pr" || !["sub", "unsub", "list"].includes(verb ?? "")) {
    io.err(`dorks: unknown command "${argv.slice(0, 2).join(" ")}"\n${USAGE}\n`);
    return 2;
  }

  const ref = prArg(verb!, rest, io);
  if (ref === undefined) return 2;
  const sock = socketOf(env);
  if (!sock) {
    io.err("dorks: DORKS_SOCK is not set; this only works inside a dork box\n");
    return 1;
  }
  try {
    await runPr(sock, verb!, ref, rest.includes("--json"), io);
    return 0;
  } catch (e) {
    io.err(`dorks: ${describeRpcError(e)}\n`);
    return 1;
  }
}

/** The PR a `dorks pr` verb names (null for `list`), or undefined after printing why the arguments are wrong. */
function prArg(verb: string, rest: string[], io: Io): PrRef | null | undefined {
  if (verb === "list") {
    if (!rest.some((a) => a !== "--json")) return null;
    io.err(`dorks: unexpected argument\n${USAGE}\n`);
    return undefined;
  }
  const ref = rest.length === 1 ? parsePrRef(rest[0]!) : null;
  if (!ref) io.err(`dorks: expected one PR reference: https://github.com/owner/name/pull/12 or owner/name#12\n`);
  return ref ?? undefined;
}

async function runPr(sock: string, verb: string, ref: PrRef | null, json: boolean, io: Io) {
  if (verb === "list") {
    const subs = await rpcCall<SubscriptionView[]>(sock, "pr.list");
    io.out(json ? JSON.stringify(subs, null, 2) + "\n" : subs.length ? subs.map(listLine).join("\n") + "\n" : "No PR subscriptions.\n");
    return;
  }
  await rpcCall(sock, verb === "sub" ? "pr.sub" : "pr.unsub", verb === "sub" ? { ...ref, source: "agent" } : ref);
  io.out(`${verb === "sub" ? "Subscribed to" : "Unsubscribed from"} ${prLabel(ref!)}\n`);
}

/** `dorks telemetry …` and `dorks prodlike run …`: the telemetry_query and prodlike_run MCP tools, from a shell. */
async function runProdlike(group: string, verb: string | undefined, rest: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const sock = socketOf(env);
  if (!sock) {
    io.err("dorks: DORKS_SOCK is not set; this only works inside a dork box\n");
    return 1;
  }
  const args = group === "telemetry" && verb?.startsWith("--") ? [verb, ...rest] : rest;
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    if (group === "telemetry") {
      const kind = verb && !verb.startsWith("--") ? verb : "errors";
      const q: Record<string, unknown> = { kind };
      for (const k of ["route", "op", "since", "half"]) if (flag(k)) q[k] = flag(k);
      const r = await rpcCall(sock, "telemetry", q, 30_000);
      io.out((args.includes("--json") ? JSON.stringify(r, null, 2) : describeTelemetry(r)) + "\n");
      return 0;
    }
    if (verb !== "run") {
      io.err(`dorks: unknown command "prodlike ${verb ?? ""}"\n${USAGE}\n`);
      return 2;
    }
    const num = (k: string) => (flag(k) ? Number(flag(k)) : undefined);
    const r = await runAb({
      dir: process.cwd(),
      call: (op, a) => rpcCall(sock, op, a, 60_000),
      baseRef: flag("base"),
      rounds: num("rounds"),
      requests: num("requests"),
      log: (s) => io.err(`${s}\n`),
      env,
    });
    io.out(describeAb(r) + "\n");
    return r.verdict === "failure" ? 3 : 0;
  } catch (e) {
    io.err(`dorks: ${e instanceof PlanError ? e.message : describeRpcError(e)}\n`);
    return 1;
  }
}
