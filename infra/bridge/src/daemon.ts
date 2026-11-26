import { Bridge, SleepingError } from "./bridge";
import { loadConfig } from "./config";
import { makeLogger, Redactor } from "./redact";
import { listenLoopback } from "./listen";
import { WsTransport } from "./transport";
import { S2Transport } from "./s2/transport";

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
