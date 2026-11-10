import { Bridge, SleepingError } from "./bridge";
import { loadConfig } from "./config";
import { makeLogger, Redactor } from "./redact";
import { WsTransport } from "./transport";

/** The bridge process itself (`dorks-bridge` with no subcommand). */
export async function runDaemon() {
  const cfg = loadConfig();
  // Best effort: the kernel keeps the initial environ readable to same-uid processes, but nothing in this process re-exports it.
  delete process.env.BRIDGE_SECRET;
  delete process.env.BRIDGE_SECRET_FILE;
  const redactor = new Redactor();
  redactor.add(cfg.bridgeSecret);
  const log = makeLogger(cfg.dorkId.slice(-6), redactor);
  const transport = new WsTransport(cfg.bridgeUrl, cfg.dorkId, cfg.bridgeSecret);
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
