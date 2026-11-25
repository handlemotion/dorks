import { Context, Effect, Layer } from "effect";
import { startBridgeLinks } from "./http/bridgeLinks";
import { AppEnv } from "./http/route";
import { uiApp } from "./http/ui";
import { startPhoneLink } from "./services/phoneLink";

// The UI API's loopback listener under Bun.serve, and the bridge links the server dials out. Each is a scoped resource: closing
// the scope stops it, closing its open connections.

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

/** The bridge links (http/bridgeLinks.ts): the server dials every awake box's bridge. Nothing listens for sandboxes. */
export class BridgeLinks extends Context.Service<BridgeLinks, { readonly stop: () => void }>()("dorks/server/BridgeLinks") {
  static readonly layer = Layer.effect(
    BridgeLinks,
    Effect.gen(function* () {
      const app = yield* AppEnv;
      return yield* Effect.acquireRelease(
        Effect.sync(() => startBridgeLinks(app)),
        (links) => Effect.sync(() => links.stop()),
      );
    }),
  );
}

/** The phone link (services/phoneLink.ts): the server dials the cloud relay so the iPhone app can reach its UI API. */
export class PhoneLinkService extends Context.Service<PhoneLinkService, { readonly stop: () => void }>()("dorks/server/PhoneLink") {
  static readonly layer = Layer.effect(
    PhoneLinkService,
    Effect.gen(function* () {
      const app = yield* AppEnv;
      const ui = uiApp(app);
      return yield* Effect.acquireRelease(
        Effect.sync(() => startPhoneLink(app, (r) => ui.fetch(r))),
        (link) => Effect.sync(() => link.stop()),
      );
    }),
  );
}
