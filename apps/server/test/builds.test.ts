import { describe, expect, it } from "vitest";
import { update } from "../src/db";
import { approveDraft, buildView, createBuild, getBuild, imageName, setBuildVar, submitDraft, writeDraft } from "../src/services/builds";
import { startRun, startRunForDork } from "../src/services/buildRuns";
import { updateSettings } from "../src/services/settings";
import { harness } from "./harness";

// Builds (docs/builds.md) against the fake provider: the run job, and the rules that keep secrets and images under the owner's control.

async function ready() {
  const h = harness();
  await updateSettings(h.app, { boatKey: "bk", githubToken: "gt", baseSnapshotId: "base-1" });
  return h;
}

const run = (h: Awaited<ReturnType<typeof ready>>, id: string) => h.app.db.get<any>("SELECT * FROM build_runs WHERE id = ?", id)!;

describe("an image run", () => {
  it("starts from the base at the build's size, clones without leaving the token, saves the image and deletes its sandbox; a failed rebuild keeps the image", async () => {
    const h = await ready();
    const d = h.snapshotDriver;
    const id = createBuild(h.app, { name: "web", machineType: "large", setupScript: "sudo apt-get install -y jq", repos: [{ repo: "acme/web", setupScript: "pnpm install" }] });
    const first = startRun(h.app, id, { kind: "image", by: "owner" });
    await h.settle();

    expect(run(h, first.id)).toMatchObject({ status: "succeeded", error: null });
    expect(d.created).toEqual([{ from: "base-1", type: "large", labelKey: "dorks-run" }]);
    expect(d.commands.some((c) => c.includes("clone") && c.includes("https://github.com/acme/web.git"))).toBe(true);
    expect(d.commands.some((c) => c.includes("rm -rf /tmp/dorks-build/gh"))).toBe(true);
    expect(d.files.get("/tmp/dorks-build/setup.sh")).toBe("sudo apt-get install -y jq");
    expect(d.files.get("/tmp/dorks-build/run")).toContain("(cd '/home/user/work/acme/web' && bash -e /tmp/dorks-build/repo-0.sh)");
    expect(getBuild(h.app, id)!.image).toBe(imageName(h.app, id));
    expect(d.boxes.size).toBe(0);
    expect((await buildView(h.app, getBuild(h.app, id)!)).image).toMatchObject({ stale: false });

    d.setupExit = 1;
    d.setupOutput = "E: Unable to locate package jq\n";
    const second = startRun(h.app, id, { kind: "image", by: "owner" });
    await h.settle();
    expect(run(h, second.id).status).toBe("failed");
    expect(run(h, second.id).error).toContain("The setup failed (exit 1).");
    expect(run(h, second.id).error).toContain("Unable to locate package jq");
    expect(getBuild(h.app, id)!.image).toBe(imageName(h.app, id));
    expect(d.boxes.size).toBe(0);
  });
});

describe("secrets", () => {
  it("build-time secrets reach image runs only; trials get the plain values; logs are redacted; a secret found on disk refuses the save", async () => {
    const h = await ready();
    const d = h.snapshotDriver;
    const id = createBuild(h.app, { name: "api", setupScript: "npm ci" });
    await setBuildVar(h.app, id, "NPM_TOKEN", { value: "npm_s3cr3tvalue", secret: true, buildTime: true });
    await setBuildVar(h.app, id, "NODE_VERSION", { value: "24", secret: false, buildTime: true });
    await setBuildVar(h.app, id, "RUNTIME_ONLY", { value: "not-for-setup", secret: true });
    d.setupOutput = "using npm_s3cr3tvalue\n";

    const trial = startRun(h.app, id, { kind: "trial", by: "owner" });
    await h.settle();
    expect(d.files.get("/tmp/dorks-build/env")).toBe("NODE_VERSION='24'\n");
    expect(run(h, trial.id).log).toBe("using [redacted]\n");
    expect(d.calls).not.toContain("save");

    const image = startRun(h.app, id, { kind: "image", by: "owner" });
    await h.settle();
    expect(d.files.get("/tmp/dorks-build/env")).toBe("NODE_VERSION='24'\nNPM_TOKEN='npm_s3cr3tvalue'\n");
    expect(run(h, image.id).status).toBe("succeeded");

    d.scanHits = "/home/user/.npmrc";
    const leaky = startRun(h.app, id, { kind: "image", by: "owner" });
    const saves = d.calls.filter((c) => c === "save").length;
    await h.settle();
    expect(run(h, leaky.id).status).toBe("failed");
    expect(run(h, leaky.id).error).toContain("/home/user/.npmrc");
    expect(d.calls.filter((c) => c === "save").length).toBe(saves);

    // A changed build-time value makes the image stale; a runtime-only one does not.
    await setBuildVar(h.app, id, "RUNTIME_ONLY", { value: "changed" });
    expect((await buildView(h.app, getBuild(h.app, id)!)).image).toMatchObject({ stale: false });
    await setBuildVar(h.app, id, "NODE_VERSION", { value: "22" });
    expect((await buildView(h.app, getBuild(h.app, id)!)).image).toMatchObject({ stale: true, staleReason: "A variable used while building changed." });
  });
});

describe("agents", () => {
  it("edit only a draft: a trial runs the draft, an image run builds the approved spec, and the owner's approval applies the draft and tells the agent", async () => {
    const h = await ready();
    const id = createBuild(h.app, { name: "web", setupScript: "echo base" });
    const dork = h.seed("idle");
    update(h.app.db, "dorks", { id: dork }, { buildId: id });

    expect(() => writeDraft(h.app, dork, { vars: [{ name: "API_KEY", secret: true, value: "leak" }] })).toThrow(/never put its value in a draft/);
    writeDraft(h.app, dork, { setupScript: "sudo apt-get install -y ripgrep", vars: [{ name: "API_KEY", secret: true, why: "for the e2e tests" }] });
    expect(getBuild(h.app, id)!.setupScript).toBe("echo base");

    const trial = startRunForDork(h.app, dork, "trial");
    expect(JSON.parse(run(h, trial.id).spec).setupScript).toBe("sudo apt-get install -y ripgrep");
    expect(run(h, trial.id).started_by).toBe(`dork:${dork}`);
    await h.settle();
    const image = startRunForDork(h.app, dork, "image");
    expect(JSON.parse(run(h, image.id).spec).setupScript).toBe("echo base");
    await h.settle();

    const draft = submitDraft(h.app, dork, "adds ripgrep");
    expect(h.events(dork).map((e) => e.body.type)).toContain("build_draft");
    const { missing } = await approveDraft(h.app, id, draft.id);
    expect(missing).toEqual([]);
    expect(getBuild(h.app, id)!.setupScript).toBe("sudo apt-get install -y ripgrep");
    const view = await buildView(h.app, getBuild(h.app, id)!);
    expect(view.approved).toBe(true);
    expect(view.vars).toEqual([{ name: "API_KEY", secret: true, buildTime: false, requested: true }]);
    expect(h.events(dork).map((e) => e.body.type)).toContain("build_decision");
    expect(h.cmds(dork).some((c) => c.kind === "user_message" && c.text?.includes("approved your machine draft"))).toBe(true);
  });
});
