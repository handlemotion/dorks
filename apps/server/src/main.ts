import { loadConfig } from "./config";
import { BridgeSession, MAX_FRAME_BYTES } from "./http/bridgeWs";
import { uiApp } from "./http/ui";
import { Scheduler } from "./lifecycle/scheduler";
import { parentPid, watchParent } from "./parentWatch";
import { createApp } from "./server";

// The sidecar entry point (Bun). Two loopback listeners: the UI API, and the bridge WebSocket that a tunnel forwards to.

const cfg = loadConfig();
const app = createApp(cfg);
const scheduler = new Scheduler(app);

const ui = Bun.serve({ hostname: "127.0.0.1", port: cfg.uiPort, fetch: uiApp(app).fetch, idleTimeout: 255 });

const bridge = Bun.serve<{ session?: BridgeSession }>({
  hostname: "127.0.0.1",
  port: cfg.bridgePort,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/bridge" && server.upgrade(req, { data: {} })) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      const session = new BridgeSession(app, { send: (t) => void ws.send(t), close: (code, reason) => ws.close(code, reason) });
      ws.data.session = session;
      session.open();
    },
    message(ws, m) {
      ws.data.session?.onMessage(typeof m === "string" ? m : m.toString());
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});

scheduler.start();
// One JSON line for the supervisor (the desktop shell waits for it).
console.log(JSON.stringify({ ready: true, ui: `http://127.0.0.1:${ui.port}`, bridge: `ws://127.0.0.1:${bridge.port}/bridge` }));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  scheduler.stop();
  await Promise.race([scheduler.idle(), new Promise((r) => setTimeout(r, 5_000))]);
  ui.stop(true);
  bridge.stop(true);
  app.db.close();
  process.exit(0);
}
const parent = parentPid(process.env);
if (parent) {
  watchParent(parent, () => {
    console.error("supervisor is gone; shutting down");
    void shutdown();
  });
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
