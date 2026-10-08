import { Bridge, SleepingError } from "./bridge";
import { loadConfig } from "./config";
import { runCredentialHelper } from "./credentials";
import { makeLogger, Redactor } from "./redact";
import { ConvexTransport } from "./transport";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "credential") {
    // `git credential-helper` entry point: dorks-bridge credential --sock <path> <get|store|erase>
    const sock = rest[rest.indexOf("--sock") + 1];
    const op = rest.filter((a, i) => a !== "--sock" && rest[i - 1] !== "--sock")[0] ?? "";
    if (!sock) return process.exit(2);
    await runCredentialHelper(sock, op, process.stdin, process.stdout);
    return process.exit(0);
  }
  if (cmd === "--version" || cmd === "version") return console.log("dorks-bridge 0.1.0");

  const cfg = loadConfig();
  // Best effort: the kernel keeps the initial environ readable to same-uid processes, but nothing in this process re-exports it.
  delete process.env.BRIDGE_SECRET;
  delete process.env.BRIDGE_SECRET_FILE;
  const redactor = new Redactor();
  redactor.add(cfg.bridgeSecret);
  const log = makeLogger(cfg.dorkId.slice(-6), redactor);
  const transport = new ConvexTransport(cfg.bridgeUrl, cfg.dorkId, cfg.bridgeSecret);
  let bridge: Bridge | undefined;
  const exit = async (code: number) => {
    await bridge?.stop().catch(() => {});
    process.exit(code);
  };
  bridge = new Bridge({ cfg, transport, log, redactor, onFatal: () => void exit(1), onSleeping: () => void exit(0) });
  process.on("SIGTERM", () => void exit(0));
  process.on("SIGINT", () => void exit(0));
  try {
    await bridge.start();
  } catch (e) {
    if (e instanceof SleepingError) {
      log("backend says this box is asleep; exiting");
      return void (await exit(0));
    }
    throw e;
  }
}

main().catch((e) => {
  console.error("[bridge] fatal:", (e as { name?: string })?.name ?? "error"); // never the message: it may echo configuration
  process.exit(1);
});
