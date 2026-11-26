import { fail, type App } from "../app";
import type { CodexSignIn } from "../lib/codexCli";

// Connecting Codex with Dorks' own ChatGPT sign-in (docs/boat.md, "ChatGPT (Codex)"): one button in onboarding or Settings. The server
// runs Codex's own browser sign-in on this computer (lib/codexCli.ts) and shows its link; once the owner approves, Codex keeps the
// sign-in in Dorks' Codex home, and every Codex sandbox gets a current access token from it (services/bridge.ts). Dorks never
// handles OpenAI's OAuth itself, and a sandbox never gets the refresh token.

export type CodexSignInState = "signed_out" | "signing_in" | "failed";

export interface CodexSignInView {
  state: CodexSignInState;
  /** signing_in: OpenAI's sign-in page. */
  url?: string;
  /** failed: what went wrong, in plain words. */
  error?: string;
}

interface Attempt {
  view: CodexSignInView;
  signIn?: CodexSignIn;
}

const attempts = new WeakMap<App, Attempt>();

function set(app: App, a: Attempt) {
  attempts.set(app, a);
  app.hub.emit({ t: "settings" });
}

/** The account Dorks' Codex is signed in with, for Settings; null when it is not. */
export const codexAccountView = (app: App) => app.codexCli.account();

/** Codex can start a sandbox with Dorks' own sign-in (no Boat environment needed). */
export const codexSignedIn = (app: App) => !!app.codexCli.account();

/** What setup shows for the ChatGPT sign-in: null once one is saved. */
export function codexSignInView(app: App): CodexSignInView | null {
  if (codexSignedIn(app)) return null;
  return attempts.get(app)?.view ?? { state: "signed_out" };
}

/** The Sign in button: returns OpenAI's link to open (the one already open when there is one). Never throws. */
export async function startCodexSignIn(app: App): Promise<CodexSignInView | null> {
  if (codexSignedIn(app)) return null;
  const now = attempts.get(app);
  if (now?.view.state === "signing_in" && now.view.url) return now.view;
  const attempt: Attempt = { view: { state: "signing_in" } };
  set(app, attempt);
  try {
    const signIn = await app.codexCli.signIn();
    if (attempts.get(app) !== attempt) {
      signIn.cancel();
      return codexSignInView(app);
    }
    const live: Attempt = { signIn, view: { state: "signing_in", url: signIn.url } };
    set(app, live);
    signIn.done.then(
      () => {
        if (attempts.get(app) !== live) return;
        attempts.delete(app);
        console.error("codex: signed in with ChatGPT");
        app.hub.emit({ t: "settings" });
      },
      (e) => {
        if (attempts.get(app) === live) set(app, { view: { state: "failed", error: messageOf(e) } });
      },
    );
  } catch (e) {
    if (attempts.get(app) === attempt) set(app, { view: { state: "failed", error: messageOf(e) } });
  }
  return codexSignInView(app);
}

/** The address a browser on another computer ended on (its localhost page could not load): finishes the sign-in here. */
export async function finishCodexSignIn(app: App, callbackUrl: string): Promise<CodexSignInView | null> {
  const signIn = attempts.get(app)?.signIn;
  if (!signIn) return fail("invalid", "No ChatGPT sign-in is waiting. Press Sign in again.");
  try {
    await signIn.finish(callbackUrl);
  } catch (e) {
    return fail("invalid", messageOf(e));
  }
  await signIn.done.catch(() => {});
  return codexSignInView(app);
}

/** Sign out: drops a sign-in in flight and Dorks' saved one. Running Codex sandboxes keep their token until it expires. */
export function signOutCodex(app: App): void {
  attempts.get(app)?.signIn?.cancel();
  attempts.delete(app);
  app.codexCli.signOut();
  app.hub.emit({ t: "settings" });
}

const messageOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : "unknown error";
  return `${m.slice(0, 300)}${/[.!?]$/.test(m) ? "" : "."}`;
};
