import { describe, expect, it } from "vite-plus/test";
import { autoConnectBoat, startBoatSignIn } from "../src/services/boatSignIn";
import { boatKey, readSettings, settingsView, updateSettings } from "../src/services/settings";
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

    // Connecting again (signed in: no browser) makes a new key; pasting a key over it revokes that one too.
    await startBoatSignIn(h.app);
    expect(readSettings(h.app).boatKeyId).toBe("key-2");
    await updateSettings(h.app, { boatKey: "pasted" });
    await settle();
    expect(h.boatCli.state.revoked).toEqual(["key-1", "key-2"]);
    expect(readSettings(h.app).boatKeyId).toBeUndefined();
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
