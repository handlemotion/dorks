import { Context, Effect, Layer } from "effect";
import { BridgeSession, MAX_FRAME_BYTES } from "./http/bridgeWs";
import { AppEnv } from "./http/route";
import { uiApp } from "./http/ui";

// The two loopback listeners under Bun.serve: the UI API, and the bridge WebSocket that a tunnel forwards to. Each is a scoped
// resource: closing the scope stops it, closing its open connections.

type Server = { readonly port: number | undefined; stop(closeActiveConnections?: boolean): Promise<void> };

const STOP_WAIT_MS = 1_000;

const listen = <S extends Server>(start: () => S) => Effect.acquireRelease(Effect.sync(start), (server) => Effect.promise(() => server.stop(true)).pipe(Effect.timeoutOption(STOP_WAIT_MS)));

export class UiListener extends Context.Service<UiListener, { readonly url: string }>()("dorks/server/UiListener") {
  static readonly layer = Layer.effect(
    UiListener,
    Effect.gen(function* () {
      const app = yield* AppEnv;
      const ui = yield* listen(() => Bun.serve({ hostname: "127.0.0.1", port: app.cfg.uiPort, fetch: uiApp(app).fetch, idleTimeout: 255 }));
      return { url: `http://127.0.0.1:${ui.port}` };
    }),
  );
}

export class BridgeListener extends Context.Service<BridgeListener, { readonly url: string }>()("dorks/server/BridgeListener") {
  static readonly layer = Layer.effect(
    BridgeListener,
    Effect.gen(function* () {
      const app = yield* AppEnv;
      const bridge = yield* listen(() =>
        Bun.serve<{ session?: BridgeSession }>({
          hostname: "127.0.0.1",
          port: app.cfg.bridgePort,
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
              void ws.data.session?.onMessage(typeof m === "string" ? m : m.toString());
            },
            close(ws) {
              ws.data.session?.close();
            },
          },
        }),
      );
      return { url: `ws://127.0.0.1:${bridge.port}/bridge` };
    }),
  );
}
