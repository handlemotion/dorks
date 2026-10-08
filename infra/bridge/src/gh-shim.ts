import { spawn, type StdioOptions } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import { isatty } from "node:tty";
import { describeRpcError, socketOf, type Io } from "./dorks";
import { findPrUrls, prLabel } from "./pr-ref";
import { rpcCall } from "./rpc";

// The `gh` shim: the bridge binary run as `gh`, installed ahead of the real gh on PATH. It asks the bridge for the current GitHub
// token (they expire hourly, so a static GH_TOKEN would go stale), runs the real gh with it in GH_TOKEN, and passes stdio and the exit
// code through untouched. The token travels only over the socket and in the child's environment: never in argv, never on disk.
// After a successful command that creates PRs it subscribes the dork to the PR URLs the command printed.

/** Commands whose successful output lists the PRs they just created, and whether the URLs may also be on stderr. */
const CREATES_PRS: { args: string[]; stderrToo: boolean }[] = [
  { args: ["pr", "create"], stderrToo: false },
  { args: ["stack", "submit"], stderrToo: true },
];
const CAPTURE_MAX = 1024 * 1024;
const TOKEN_WAIT_MS = 5_000;
const SUB_WAIT_MS = 12_000;

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `DORKS_REAL_GH`, else the first `gh` on PATH that is not this shim (compared by real path, so symlinks to the bundle are skipped). */
export function findRealGh(env: NodeJS.ProcessEnv, self: string): string | null {
  if (env.DORKS_REAL_GH) return isExecutable(env.DORKS_REAL_GH) ? env.DORKS_REAL_GH : null;
  const me = realpathSync(self);
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "gh");
    if (isExecutable(candidate) && realpathSync(candidate) !== me) return candidate;
  }
  return null;
}

export async function runGhShim(argv: string[], env: NodeJS.ProcessEnv, self: string, io: Io): Promise<number> {
  const gh = findRealGh(env, self);
  if (!gh) {
    io.err("gh: the real gh is not installed in this box (set DORKS_REAL_GH or put it on PATH)\n");
    return 127;
  }
  const sock = socketOf(env);
  const childEnv = { ...env };
  if (sock) {
    try {
      childEnv.GH_TOKEN = (await rpcCall<{ token: string }>(sock, "token", { host: "github.com" }, TOKEN_WAIT_MS)).token;
    } catch (e) {
      io.err(`dorks: no GitHub token for gh (${describeRpcError(e)}); running it without\n`);
    }
  }

  const rule = argv.includes("-h") || argv.includes("--help") ? undefined : CREATES_PRS.find((r) => r.args.every((a, i) => argv[i] === a));
  const capture = !!rule && !isatty(1); // a pipe changes what gh prints on a terminal; only watch when output is not interactive
  const stdio: StdioOptions = ["inherit", capture ? "pipe" : "inherit", capture && rule!.stderrToo ? "pipe" : "inherit"];
  const child = spawn(gh, argv, { env: childEnv, stdio });
  let seen = "";
  const watch = (stream: NodeJS.ReadableStream | null, sink: "stdout" | "stderr") => {
    if (!stream) return;
    stream.on("data", (d: Buffer) => seen.length < CAPTURE_MAX && (seen += d.toString("utf8")));
    stream.pipe(process[sink], { end: false });
  };
  watch(child.stdout, "stdout");
  watch(child.stderr, "stderr");

  // A terminal delivers ^C to gh itself; otherwise relay the signals so killing the shim stops gh. (isatty, not process.stdin: touching
  // that can switch the descriptor we share with gh to non-blocking mode.)
  const relay = (["SIGTERM", "SIGHUP", ...(isatty(0) ? [] : ["SIGINT"])] as NodeJS.Signals[]).map((sig) => {
    const h = () => child.kill(sig);
    process.on(sig, h);
    return () => process.off(sig, h);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => {
      io.err("gh: could not start the real gh\n");
      resolve(127);
    });
    child.on("close", (c, sig) => resolve(c ?? 128 + (sig ? osConstants.signals[sig] : 0)));
  });
  relay.forEach((off) => off());

  if (code === 0 && sock && rule) await subscribeTo(sock, seen, io);
  return code;
}

/** Best effort and quiet: a failure costs one stderr line and never changes gh's exit code. */
async function subscribeTo(sock: string, output: string, io: Io) {
  const failed: string[] = [];
  let reason = "";
  for (const ref of findPrUrls(output)) {
    try {
      await rpcCall(sock, "pr.sub", { ...ref, source: "auto" }, SUB_WAIT_MS);
    } catch (e) {
      failed.push(prLabel(ref));
      reason = describeRpcError(e);
    }
  }
  if (failed.length) io.err(`dorks: could not subscribe to ${failed.join(", ")} (${reason}); run \`dorks pr sub\` to retry\n`);
}
