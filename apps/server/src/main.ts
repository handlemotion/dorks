import { Cause, Deferred, Effect, Exit, Layer } from "effect";
import { BridgeLinks, PhoneLinkService, UiListener } from "./listeners";
import { Scheduler } from "./lifecycle/scheduler";
import { parentPid, watchParent } from "./parentWatch";
import { appLayer } from "./server";

// The sidecar entry point (Bun). The app is a stack of Layers: config, then the database and hub, the app, the UI listener and the bridge links, and the
// scheduler last. Shutdown (SIGTERM, SIGINT, or the supervisor going away) closes the stack in reverse: stop the scheduler and
// drain its jobs (at most 5 s), stop the listener and the bridge links, close the database.

const main = Scheduler.layer.pipe(Layer.provideMerge(Layer.mergeAll(UiListener.layer, BridgeLinks.layer, PhoneLinkService.layer)), Layer.provideMerge(appLayer));

const stopRequested = Deferred.makeUnsafe<void>();
const requestStop = () => void Deferred.doneUnsafe(stopRequested, Effect.void); // a second signal is a no-op

const program = Effect.gen(function* () {
  const ui = yield* UiListener;
  yield* BridgeLinks;
  yield* PhoneLinkService;
  // One JSON line for the supervisor (the desktop shell and scripts/e2e wait for it).
  console.log(JSON.stringify({ ready: true, ui: ui.url }));
  yield* Deferred.await(stopRequested);
}).pipe(Effect.provide(main));

const parent = parentPid(process.env);
if (parent) {
  watchParent(parent, () => {
    console.error("supervisor is gone; shutting down");
    requestStop();
  });
}
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

void Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isFailure(exit)) console.error("server failed", Cause.pretty(exit.cause));
  process.exit(Exit.isSuccess(exit) ? 0 : 1);
});
