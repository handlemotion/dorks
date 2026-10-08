import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { runCredentialHelper } from "./credentials";
import { runDorks } from "./dorks";
import { runGhShim } from "./gh-shim";

// One bundled binary, several entry points. Which one runs is decided by the name it is invoked as (argv[1], so symlinks work), or by
// its first argument when it is run as `dorks-bridge`:
//   dorks-bridge                         the bridge daemon
//   dorks-bridge credential --sock …     git credential helper
//   dorks … / dorks-bridge dorks …       the agent CLI (dorks.ts)
//   gh …    / dorks-bridge gh …          the gh shim (gh-shim.ts)
// The snapshot installs the bundle once and symlinks `dorks` and `gh` to it (infra/snapshot).
const io = { out: (s: string) => void process.stdout.write(s), err: (s: string) => void process.stderr.write(s) };

async function main() {
  const invokedAs = basename(process.argv[1] ?? "").replace(/\.[cm]?js$/, "");
  const [cmd, ...rest] = invokedAs === "dorks" || invokedAs === "gh" ? [invokedAs, ...process.argv.slice(2)] : process.argv.slice(2);
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
  await (await import("./daemon")).runDaemon(); // the daemon pulls in the Convex client; the short-lived commands above never load it
}

main().catch((e) => {
  console.error("[bridge] fatal:", (e as { name?: string })?.name ?? "error"); // never the message: it may echo configuration
  process.exit(1);
});
