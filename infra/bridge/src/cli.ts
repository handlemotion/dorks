import { realpathSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { runCredentialHelper } from "./credentials";
import { runDorks } from "./dorks";
import { runGhShim } from "./gh-shim";
import { serveMcp } from "./mcp";

// One bundled binary, several entry points. Which one runs is decided by the name it is invoked as (argv[1], so symlinks work), or by
// its first argument when it is run as `dorks-bridge`:
//   dorks-bridge                         the bridge daemon
//   dorks-bridge credential --sock …     git credential helper
//   dorks … / dorks-bridge dorks …       the agent CLI (dorks.ts)
//   dorks mcp                            the agent's MCP tools, a stdio server started by Claude Code (mcp.ts)
//   gh …    / dorks-bridge gh …          the gh shim (gh-shim.ts)
// The snapshot installs the bundle once and symlinks `dorks` and `gh` to it (infra/snapshot).
// Synchronous writes to the raw descriptors: the `process.stdout` / `process.stderr` streams can switch a shared pipe to non-blocking
// mode, which the real gh (a child of the shim, inheriting the same descriptors) must not be exposed to.
const readStdin = async () => {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
};
const io = { out: (s: string) => void writeSync(1, s), err: (s: string) => void writeSync(2, s), readInput: readStdin };

async function main() {
  const invokedAs = basename(process.argv[1] ?? "").replace(/\.[cm]?js$/, "");
  const [cmd, ...rest] = invokedAs === "dorks" || invokedAs === "gh" ? [invokedAs, ...process.argv.slice(2)] : process.argv.slice(2);
  if (cmd === "dorks" && rest[0] === "mcp" && rest.length === 1) {
    await serveMcp(process.env, process.stdin, (s) => void process.stdout.write(s)); // a long-lived server speaking on stdio, unlike the rest
    return process.exit(0);
  }
  if (cmd === "dorks") return process.exit(await runDorks(rest, process.env, io));
  if (cmd === "gh") return process.exit(await runGhShim(rest, process.env, realpathSync(process.argv[1]!), io));
  if (cmd === "credential") {
    // `git credential-helper` entry point: dorks-bridge credential --sock <path> <get|store|erase>
    const sock = rest[rest.indexOf("--sock") + 1];
    const op = rest.filter((a, i) => a !== "--sock" && rest[i - 1] !== "--sock")[0] ?? "";
    if (!sock) return process.exit(2);
    await runCredentialHelper(sock, op, process.stdin, process.stdout);
    return process.exit(0);
  }
  if (cmd === "--version" || cmd === "version") return console.log("dorks-bridge 0.1.0");
  await (await import("./daemon")).runDaemon(); // the daemon pulls in the socket transport; the short-lived commands above never load it
}

main().catch((e) => {
  console.error("[bridge] fatal:", (e as { name?: string })?.name ?? "error"); // never the message: it may echo configuration
  process.exit(1);
});
