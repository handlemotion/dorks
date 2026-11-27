import { describe, expect, it } from "vite-plus/test";
import { AppFail } from "../src/app";
import { update } from "../src/db";
import { createDork } from "../src/services/dorks";
import { assertMayDrive, localAvailability } from "../src/services/localDorks";
import { rememberPlan, sandboxes } from "../src/services/plan";
import { harness } from "./harness";

// Dorks Free runs chats on this Mac only (services/plan.ts): no sandbox is created or woken, a new session defaults to local, and the
// owner can still drive local chats from their phone. A paid plan lifts it.

const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof AppFail ? e.error.code : String(e);
  }
};

describe("Dorks Free", () => {
  it("refuses sandboxes, starts sessions on this Mac, and does not wake an old sandbox chat; a paid plan lifts it", async () => {
    const h = harness({ config: { sandboxesWithoutPlan: false } });
    update(h.app.db, "settings", { id: 1 }, { cloudOrgId: "personal-1", claudeTokenEnc: "x", githubConnected: true });
    const old = h.seed("sleeping", { boxId: "box-old" }); // made while sandboxes were allowed
    expect(sandboxes(h.app).available).toBe(false);
    expect(codeOf(() => createDork(h.app, { repo: "octo/app", message: "hi", location: "cloud" }))).toBe("not_configured");
    const id = createDork(h.app, { repo: "octo/app", message: "hi" });
    expect(h.app.db.get<{ location: string }>("SELECT location FROM dorks WHERE id = ?", id)?.location).toBe("local");

    h.sendMessage(old);
    await h.settle();
    expect(h.box.calls).not.toContain("resume");
    expect(JSON.stringify(h.events(old).map((e) => e.body))).toContain("Sandboxes need Dorks Teams or Dorks Cloud");

    rememberPlan(h.app, [{ id: "personal-1", plan: "cloud" }]); // upgraded
    expect(sandboxes(h.app).available).toBe(true);
    expect(h.app.db.get("SELECT 1 AS x FROM meta WHERE key = 'cloud_plan'")).toBeTruthy();
    update(h.app.db, "settings", { id: 1 }, { cloudOrgId: null }); // unpaired: the paid plan was that org's, not this Mac's
    expect(sandboxes(h.app).available).toBe(false);
    update(h.app.db, "settings", { id: 1 }, { cloudOrgId: "personal-1" });
    expect(codeOf(() => createDork(h.app, { repo: "octo/app", message: "hi", location: "cloud" }))).toBe("onboarding_incomplete"); // only Boat setup is missing now
  });

  it("lets the owner drive local chats from their phone, never a teammate", () => {
    const h = harness();
    update(h.app.db, "settings", { id: 1 }, { cloudOwner: { id: "u_me", name: "Me" } });
    const member = (id: string) => ({ kind: "member" as const, member: { id, name: "", email: "", org: "o", role: "member" as const, plan: "local" as const } });
    expect(codeOf(() => assertMayDrive(h.app, member("u_me"), { location: "local" }))).toBe("ok");
    expect(codeOf(() => assertMayDrive(h.app, { kind: "phone" }, { location: "local" }))).toBe("ok");
    expect(codeOf(() => assertMayDrive(h.app, member("u_other"), { location: "local" }))).toBe("forbidden");
    expect(localAvailability(h.app, member("u_other")).available).toBe(false);
  });
});
