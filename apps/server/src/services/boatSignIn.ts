import type { App } from "../app";
import { update } from "../db";
import type { BoatSignIn } from "../lib/boatCli";
import { checkBoat } from "./boatCheck";
import { readSettings, updateSettings } from "./settings";
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

/** What the checklist shows for Boat. Null when a key is saved, or with simulated sandboxes (they take any key, from Settings). */
export function boatSignInView(app: App): BoatSignInView | null {
  if (app.cfg.boxProvider === "sim" || readSettings(app).boatKeyEnc) return null;
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
  try {
    if (await app.boatCli.signedIn()) await connect(app);
    else set(app, { state: "signed_out" });
  } catch (e) {
    set(app, { state: "failed", error: messageOf(e) });
  }
}

/**
 * The checklist's Sign in button: connects at once when the CLI is signed in, else starts the browser sign-in and returns its link
 * (a link already open and not expired is returned again). The key is made when the sign-in finishes.
 */
export async function startBoatSignIn(app: App): Promise<BoatSignInView | null> {
  if (app.cfg.boxProvider === "sim" || readSettings(app).boatKeyEnc) return null;
  update(app.db, "settings", { id: 1 }, { boatAuto: 1 }); // the owner asked: automatic connecting is on again
  const now = current(app).view;
  if (now.state === "connecting") return now;
  if (now.state === "signing_in" && now.expiresAt && Date.parse(now.expiresAt) > app.now()) return now;
  if (!app.boatCli.bin) {
    set(app, { state: "unavailable" });
    return current(app).view;
  }
  try {
    if (await app.boatCli.signedIn()) {
      await connect(app);
      return boatSignInView(app);
    }
    const { link, done } = await app.boatCli.login();
    set(app, signingIn(link));
    // A sign-in replaced by a newer one (pressed again after its link expired) fails; only the current one may report.
    const stillCurrent = () => current(app).view.url === link.url;
    done.then(
      () => connect(app),
      (e) => {
        if (stillCurrent()) set(app, { state: "failed", error: `The Boat sign-in did not finish: ${messageOf(e)}` });
      },
    );
  } catch (e) {
    set(app, { state: "failed", error: messageOf(e) });
  }
  return current(app).view;
}

const signingIn = (link: BoatSignIn): BoatSignInView => ({ state: "signing_in", url: link.url, userCode: link.userCode, expiresAt: link.expiresAt });

/** Makes Dorks' key, checks Boat will run sandboxes with it, and saves it with the CLI's organization. Never throws. */
async function connect(app: App): Promise<void> {
  set(app, { state: "connecting" });
  let made: { id: string; secret: string } | undefined;
  try {
    const org = await app.boatCli.org();
    made = await app.boatCli.createKey(KEY_NAME);
    const check = await checkBoat(app, { boatKey: made.secret, boatOrg: org ?? "" });
    if (check.status !== "ok" && check.status !== "unreachable") {
      set(app, { state: "failed", error: check.message });
      await app.boatCli.revokeKey(made.id).catch(() => {});
      return;
    }
    // Saving a key revokes the one Dorks made before (updateSettings), so reconnecting leaves no key behind.
    await updateSettings(app, { boatKey: made.secret, boatOrg: org ?? "" });
    update(app.db, "settings", { id: 1 }, { boatKeyId: made.id });
    forgetUsage(app);
    buildIfMissing(app, { retryFailed: true });
    console.error("boat: connected with the Boat CLI's login");
    set(app, { state: "checking" }); // shown again only if the key is cleared
  } catch (e) {
    if (made) await app.boatCli.revokeKey(made.id).catch(() => {});
    set(app, { state: "failed", error: messageOf(e) });
  }
}

const messageOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : "unknown error";
  return `${m.slice(0, 300)}${/[.!?]$/.test(m) ? "" : "."}`;
};
