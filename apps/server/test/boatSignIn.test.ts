import { describe, expect, it } from "vite-plus/test";
import { autoConnectBoat, startBoatSignIn } from "../src/services/boatSignIn";
import { autoConnectGithub, boatKey, readSettings, settingsView, updateSettings } from "../src/services/settings";
import { harness } from "./harness";

// Connecting Boat with the Boat CLI's login (services/boatSignIn.ts) against a fake CLI and Boat's documented /limits answers.

/** Lets the background work (the sign-in finishing, a revoke) run. */
const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 5));
};

function boat(plan: (key: string) => string = () => "starter") {
  return harness({
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      return Response.json({ sandboxPlanKey: plan(key), canStart: true });
    }) as typeof fetch,
  });
}

describe("Boat sign-in with the Boat CLI", () => {
  it("signed out: one sign-in, then the key and organization are saved; no key is left behind", async () => {
    const h = boat();
    await autoConnectBoat(h.app);
    expect(settingsView(h.app).boatSignIn).toEqual({ state: "signed_out" });

    const link = await startBoatSignIn(h.app);
    expect(link).toMatchObject({ state: "signing_in", url: expect.stringMatching(/^https:/), userCode: "ABCD-EFGH" });
    expect((await startBoatSignIn(h.app))?.url).toBe(link?.url); // a second press returns the same open link

    h.boatCli.state.org = "team_1";
    h.boatCli.state.login!.finish();
    await settle();
    expect(await boatKey(h.app)).toBe("boat_secret_key-1");
    expect(readSettings(h.app)).toMatchObject({ boatOrg: "team_1", boatKeyId: "key-1" });
    expect(settingsView(h.app).boatSignIn).toBeNull();

    // Clearing the key revokes Dorks' own key and stops connecting by itself, though the CLI is still signed in.
    await updateSettings(h.app, { boatKey: "" });
    await settle();
    expect(h.boatCli.state.revoked).toEqual(["key-1"]);
    h.clock.t += 60_000;
    await autoConnectBoat(h.app);
    expect(h.boatCli.state.keys).toEqual(["key-1"]);
    expect(settingsView(h.app).boatSignIn).toEqual({ state: "signed_out" }); // the row offers Sign in again

    // Connecting again (signed in: no browser) makes a new key; pasting a key over it revokes that one too.
    await startBoatSignIn(h.app);
    expect(readSettings(h.app).boatKeyId).toBe("key-2");
    await updateSettings(h.app, { boatKey: "pasted" });
    await settle();
    expect(h.boatCli.state.revoked).toEqual(["key-1", "key-2"]);
    expect(readSettings(h.app).boatKeyId).toBeUndefined();
  });

  it("a key the owner saves or clears while a sign-in is open wins: the sign-in's key is revoked, not saved", async () => {
    const h = boat();
    await startBoatSignIn(h.app);
    await updateSettings(h.app, { boatKey: "pasted", boatOrg: "team_mine" });
    h.boatCli.state.login!.finish();
    await settle();
    expect(await boatKey(h.app)).toBe("pasted");
    expect(readSettings(h.app).boatOrg).toBe("team_mine");
    expect(h.boatCli.state.keys).toEqual([]); // the finished sign-in no longer makes a key

    // Cleared while the key is being made: made, then revoked, and the key stays cleared.
    const c = boat();
    c.boatCli.state.signedIn = true;
    const createKey = c.boatCli.createKey.bind(c.boatCli);
    c.boatCli.createKey = async (name) => {
      const made = await createKey(name);
      await updateSettings(c.app, { boatKey: "" });
      return made;
    };
    await autoConnectBoat(c.app);
    expect(await boatKey(c.app)).toBeUndefined();
    expect(c.boatCli.state.revoked).toEqual(["key-1"]);
    expect(readSettings(c.app).boatAuto).toBe(false);
  });

  it("signed in: connects on start with no click; an account Boat will not run sandboxes for fails and keeps no key", async () => {
    const ok = boat();
    ok.boatCli.state.signedIn = true;
    await autoConnectBoat(ok.app);
    expect(await boatKey(ok.app)).toBe("boat_secret_key-1");

    const trial = boat(() => "trial");
    trial.boatCli.state.signedIn = true;
    await autoConnectBoat(trial.app);
    expect(await boatKey(trial.app)).toBeUndefined();
    expect(settingsView(trial.app).boatSignIn).toMatchObject({ state: "failed", error: expect.stringMatching(/paid Boat plan/) });
    expect(trial.boatCli.state.revoked).toEqual(["key-1"]);
  });
});

describe("GitHub with the GitHub CLI", () => {
  it("an automatic connect still in flight never undoes the owner's disconnect", async () => {
    const h = harness();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const ghLogin = h.app.ghLogin.bind(h.app);
    h.app.ghLogin = async () => {
      await slow;
      return ghLogin();
    };
    const auto = autoConnectGithub(h.app);
    h.app.ghLogin = ghLogin;
    await updateSettings(h.app, { githubConnected: true });
    await updateSettings(h.app, { githubConnected: false });
    release();
    await auto;
    expect(readSettings(h.app)).toMatchObject({ githubConnected: false, githubAuto: false });
  });
});

describe("Boat sign-in races", () => {
  it("a background check that answers after Sign in was pressed neither replaces its link nor stops its key", async () => {
    const h = boat();
    let answer!: (v: boolean) => void;
    const signedIn = h.boatCli.signedIn.bind(h.boatCli);
    h.boatCli.signedIn = () => new Promise<boolean>((r) => (answer = r)); // the background check hangs on `boat status`
    const background = autoConnectBoat(h.app);
    h.boatCli.signedIn = signedIn;
    const link = await startBoatSignIn(h.app);
    answer(false);
    await background;
    expect(settingsView(h.app).boatSignIn).toMatchObject({ state: "signing_in", url: link?.url });
    h.boatCli.state.login!.finish();
    await settle();
    expect(await boatKey(h.app)).toBe("boat_secret_key-1");
  });
});
