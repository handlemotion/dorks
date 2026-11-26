import { Bridge, SleepingError } from "./bridge";
import { loadConfig } from "./config";
import { makeLogger, Redactor } from "./redact";
import { listenLoopback } from "./listen";
import { WsTransport } from "./transport";
import { S2Transport } from "./s2/transport";

/**
 * A local dork's bridge is a child of the owner's server (DORKS_PARENT_PID, docs/local-dorks.md): it stops with it, so no bridge and
 * agent are left running on the owner's computer after the app quits or the server is killed. A box's bridge has no parent to watch.
 */
function watchParent(raw: string | undefined, onGone: () => void, everyMs = 2_000) {
  const pid = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  if (pid <= 1) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const timer = setInterval(() => {
    if (alive()) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref();
}

/** The bridge process itself (`dorks-bridge` with no subcommand). */
export async function runDaemon() {
  const cfg = loadConfig();
  // Best effort: the kernel keeps the initial environ readable to same-uid processes, but nothing in this process re-exports it.
  delete process.env.BRIDGE_SECRET;
  delete process.env.BRIDGE_SECRET_FILE;
  const redactor = new Redactor();
  redactor.add(cfg.bridgeSecret);
  const log = makeLogger(cfg.dorkId.slice(-6), redactor);
  // A cloud org's box listens on nothing: it reaches s2 and the Worker itself (s2/transport.ts).
  const transport =
    cfg.transport === "s2"
      ? new S2Transport({ dorkId: cfg.dorkId, secret: cfg.bridgeSecret, workerUrl: cfg.workerUrl!, log })
      : new WsTransport(
          listenLoopback(cfg.bridgePort, (e) => {
            log("bridge listener failed:", e.message);
            process.exit(1);
          }),
          cfg.dorkId,
          cfg.bridgeSecret,
        );
  let bridge: Bridge | undefined;
  const exit = async (code: number) => {
    await bridge?.stop().catch(() => {});
    process.exit(code);
  };
  bridge = new Bridge({ cfg, transport, log, redactor, onFatal: () => void exit(1), onSleeping: () => void exit(0) });
  process.on("SIGTERM", () => void exit(0));
  process.on("SIGINT", () => void exit(0));
  watchParent(process.env.DORKS_PARENT_PID, () => {
    log("the server that started this bridge is gone; exiting");
    void exit(0);
  });
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
