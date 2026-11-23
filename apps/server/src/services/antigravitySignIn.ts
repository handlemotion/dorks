import { fail, type App } from "../app";
import type { AgySignIn } from "../lib/agyCli";
import { readSettings, updateSettings } from "./settings";

// Connecting Antigravity (Google's agy CLI, docs/boat.md): one button in setup, onboarding or Settings. The server runs agy's own
// Google sign-in (lib/agyCli.ts) and shows its link; once the owner approves in the browser, agy's token is stored encrypted like
// the Claude token and every Antigravity sandbox gets it. Dorks never handles Google's OAuth itself.

export type AntigravitySignInState = "signed_out" | "installing" | "signing_in" | "failed";

export interface AntigravitySignInView {
  state: AntigravitySignInState;
  /** signing_in: Google's consent page. */
  url?: string;
  /** failed: what went wrong, in plain words. */
  error?: string;
}

interface Attempt {
  view: AntigravitySignInView;
  signIn?: AgySignIn;
}

const attempts = new WeakMap<App, Attempt>();

function set(app: App, a: Attempt) {
  attempts.set(app, a);
  app.hub.emit({ t: "settings" });
}

/** What setup shows for Antigravity: null once a sign-in is saved. */
export function antigravitySignInView(app: App): AntigravitySignInView | null {
  if (readSettings(app).antigravityTokenEnc) return null;
  return attempts.get(app)?.view ?? { state: "signed_out" };
}

/** The Sign in button: returns the Google link to open (the one already open when there is one). Never throws. */
export async function startAntigravitySignIn(app: App): Promise<AntigravitySignInView | null> {
  if (readSettings(app).antigravityTokenEnc) return null;
  const now = attempts.get(app);
  if (now && (now.view.state === "signing_in" || now.view.state === "installing")) return now.view;
  const attempt: Attempt = { view: { state: app.agyCli.bin() ? "signing_in" : "installing" } };
  set(app, attempt);
  const run = begin(app, attempt);
  // Downloading agy takes minutes: the button answers at once and the link follows on the live stream.
  if (attempt.view.state === "installing") return attempt.view;
  await run;
  return antigravitySignInView(app);
}

/** Starts agy's sign-in for this attempt and follows it to the saved token. Never throws. */
async function begin(app: App, attempt: Attempt): Promise<void> {
  const current = () => attempts.get(app) === attempt;
  try {
    const signIn = await app.agyCli.signIn();
    if (!current()) return signIn.cancel();
    attempt.signIn = signIn;
    set(app, { ...attempt, view: { state: "signing_in", url: signIn.url } });
    const live = attempts.get(app)!;
    signIn.done.then(
      async (token) => {
        if (attempts.get(app) !== live) return;
        await updateSettings(app, { antigravityToken: token });
        attempts.delete(app);
        console.error("antigravity: signed in with Google");
        app.hub.emit({ t: "settings" });
      },
      (e) => {
        if (attempts.get(app) === live) set(app, { view: { state: "failed", error: messageOf(e) } });
      },
    );
  } catch (e) {
    if (current()) set(app, { view: { state: "failed", error: messageOf(e) } });
  }
}

/** The address a browser on another computer ended on (its localhost page could not load): finishes the sign-in here. */
export async function finishAntigravitySignIn(app: App, callbackUrl: string): Promise<AntigravitySignInView | null> {
  const signIn = attempts.get(app)?.signIn;
  if (!signIn) return fail("invalid", "No Google sign-in is waiting. Press Sign in again.");
  try {
    await signIn.finish(callbackUrl);
  } catch (e) {
    return fail("invalid", messageOf(e));
  }
  await signIn.done.catch(() => {});
  return antigravitySignInView(app);
}

/** Saving or clearing the token from Settings drops a sign-in in flight. */
export function cancelAntigravitySignIn(app: App): void {
  attempts.get(app)?.signIn?.cancel();
  attempts.delete(app);
}

const messageOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : "unknown error";
  return `${m.slice(0, 300)}${/[.!?]$/.test(m) ? "" : "."}`;
};
