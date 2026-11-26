import { fail, type App } from "../app";

// While this Mac's org moves to the cloud (services/cloudMove.ts), nothing may start or wake a session: a message, a notification or
// an automation run that landed after its session was copied would stay on this Mac only. The lifecycle refuses those inputs
// (rolling their transaction back) until the move ends, done or failed.

const frozen = new WeakMap<App, string>();

export const freeze = (app: App, why: string) => void frozen.set(app, why);
export const unfreeze = (app: App) => void frozen.delete(app);
export const isFrozen = (app: App) => frozen.has(app);

/** Fails with `conflict` while the server is frozen. */
export function assertNotFrozen(app: App) {
  const why = frozen.get(app);
  if (why) fail("conflict", why);
}
