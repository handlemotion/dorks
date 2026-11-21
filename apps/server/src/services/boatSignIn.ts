import type { App } from "../app";
import { update } from "../db";
import type { BoatSignIn } from "../lib/boatCli";
import { checkBoat } from "./boatCheck";
import { readSettings, StaleSignIn, updateSettings } from "./settings";
import { buildIfMissing } from "./snapshot";
import { forgetUsage } from "./usage";

// Connecting Boat without a pasted key (docs/boat.md, "Sign in with the Boat CLI"). When the Boat CLI on this computer is signed
// in, the server makes itself a key on start, with no click. When it is signed out, the setup checklist's one button starts
// `boat login --wait` and opens the link it prints; the key follows as soon as the browser sign-in finishes. A pasted key (Settings)
// still works, and clearing the key stops all of this until the owner connects again.

export type BoatSignInState = "unavailable" | "checking" | "signed_out" | "signing_in" | "connecting" | "failed";

export interface BoatSignInView {
  state: BoatSignInState;
  /** signing_in: the browser link, and the code it may ask for. */
  url?: string;
  userCode?: string;
  expiresAt?: string;
  /** failed: what went wrong, in plain words. */
  error?: string;
}

interface Status {
  view: BoatSignInView;
  checkedAt: number;
}

const RECHECK_MS = 10_000;
const KEY_NAME = "Dorks";
const status = new WeakMap<App, Status>();

const current = (app: App): Status => status.get(app) ?? { view: { state: app.boatCli.bin ? "checking" : "unavailable" }, checkedAt: 0 };

function set(app: App, view: BoatSignInView) {
  const before = status.get(app)?.view;
  status.set(app, { view, checkedAt: app.now() });
  if (JSON.stringify(before) !== JSON.stringify(view)) app.hub.emit({ t: "settings" });
}

const busy = (s: BoatSignInState) => s === "signing_in" || s === "connecting";

// Every attempt remembers the generation it started in. Saving or clearing the Boat key from Settings starts a new one, so an
// attempt still in flight (a browser sign-in, a key being made) cannot overwrite what the owner chose: its key is revoked instead.
const generations = new WeakMap<App, number>();
const generation = (app: App) => generations.get(app) ?? 0;

/** The Boat key was saved or cleared by the owner (updateSettings): drop what is in flight. */
export function invalidateBoatSignIn(app: App): void {
  generations.set(app, generation(app) + 1);
  status.delete(app);
}

/** Sets the state only for an attempt that is still current. */
const setIf = (app: App, gen: number, view: BoatSignInView) => {
  if (generation(app) === gen) set(app, view);
};

/** What the checklist shows for Boat. Null when a key is saved, or with simulated sandboxes (they take any key, from Settings). */
export function boatSignInView(app: App): BoatSignInView | null {
  const s = readSettings(app);
  if (app.cfg.boxProvider === "sim" || s.boatKeyEnc) return null;
  // The owner cleared the key, so nothing connects by itself: offer Sign in (which turns it back on).
  if (!s.boatAuto) return { state: app.boatCli.bin ? "signed_out" : "unavailable" };
  return current(app).view;
}

/**
 * With no key saved, makes one when the Boat CLI is signed in; otherwise notes that it is signed out. Called on start and when the
 * settings are read (at most every 10 s, so a `boat login` in a terminal is picked up). Never throws.
 */
export async function autoConnectBoat(app: App): Promise<void> {
  if (app.cfg.boxProvider === "sim") return;
  const s = readSettings(app);
  if (s.boatKeyEnc || !s.boatAuto) return;
  const now = current(app);
  if (busy(now.view.state) || (now.checkedAt && app.now() - now.checkedAt < RECHECK_MS)) return;
  if (!app.boatCli.bin) return set(app, { state: "unavailable" });
  status.set(app, { view: now.view, checkedAt: app.now() }); // claim the check; no event for a recheck that changes nothing
  const gen = generation(app);
  try {
    if (await app.boatCli.signedIn()) await connect(app, gen);
    else setIf(app, gen, { state: "signed_out" });
  } catch (e) {
    setIf(app, gen, { state: "failed", error: messageOf(e) });
  }
}

/**
 * The checklist's Sign in button: connects at once when the CLI is signed in, else starts the browser sign-in and returns its link
 * (a link already open and not expired is returned again). The key is made when the sign-in finishes.
 */
export async function startBoatSignIn(app: App): Promise<BoatSignInView | null> {
  if (app.cfg.boxProvider === "sim" || readSettings(app).boatKeyEnc) return null;
  update(app.db, "settings", { id: 1 }, { boatAuto: 1 }); // the owner asked: automatic connecting is on again
  const gen = generation(app);
  const now = current(app).view;
  if (now.state === "connecting") return now;
  if (now.state === "signing_in" && now.expiresAt && Date.parse(now.expiresAt) > app.now()) return now;
  if (!app.boatCli.bin) {
    set(app, { state: "unavailable" });
    return current(app).view;
  }
  try {
    if (await app.boatCli.signedIn()) {
      await connect(app, gen);
      return boatSignInView(app);
    }
    const { link, done } = await app.boatCli.login();
    setIf(app, gen, signingIn(link));
    // A sign-in replaced by a newer one (pressed again after its link expired) fails; only the current one may report.
    const stillCurrent = () => generation(app) === gen && current(app).view.url === link.url;
    done.then(
      () => (stillCurrent() ? connect(app, gen) : undefined),
      (e) => {
        if (stillCurrent()) set(app, { state: "failed", error: `The Boat sign-in did not finish: ${messageOf(e)}` });
      },
    );
  } catch (e) {
    setIf(app, gen, { state: "failed", error: messageOf(e) });
  }
  return current(app).view;
}

const signingIn = (link: BoatSignIn): BoatSignInView => ({ state: "signing_in", url: link.url, userCode: link.userCode, expiresAt: link.expiresAt });

/** Makes Dorks' key, checks Boat will run sandboxes with it, and saves it with the CLI's organization. Never throws. */
async function connect(app: App, gen: number): Promise<void> {
  setIf(app, gen, { state: "connecting" });
  const stillCurrent = () => generation(app) === gen && !readSettings(app).boatKeyEnc;
  let made: { id: string; secret: string } | undefined;
  try {
    const org = await app.boatCli.org();
    made = await app.boatCli.createKey(KEY_NAME);
    const check = await checkBoat(app, { boatKey: made.secret, boatOrg: org ?? "" });
    if (check.status !== "ok" && check.status !== "unreachable") {
      setIf(app, gen, { state: "failed", error: check.message });
      await app.boatCli.revokeKey(made.id).catch(() => {});
      return;
    }
    // Saving a key revokes the one Dorks made before (updateSettings), so reconnecting leaves no key behind. It is not saved if
    // the owner saved or cleared a key meanwhile (updateSettings checks right before it writes).
    await updateSettings(app, { boatKey: made.secret, boatOrg: org ?? "" }, { fromSignIn: true, unless: () => !stillCurrent() });
    update(app.db, "settings", { id: 1 }, { boatKeyId: made.id });
    forgetUsage(app);
    buildIfMissing(app, { retryFailed: true });
    console.error("boat: connected with the Boat CLI's login");
    set(app, { state: "checking" }); // shown again only if the key is cleared
  } catch (e) {
    if (made) await app.boatCli.revokeKey(made.id).catch(() => {});
    if (!(e instanceof StaleSignIn)) setIf(app, gen, { state: "failed", error: messageOf(e) });
  }
}

const messageOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : "unknown error";
  return `${m.slice(0, 300)}${/[.!?]$/.test(m) ? "" : "."}`;
};
