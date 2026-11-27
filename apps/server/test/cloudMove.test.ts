import { describe, expect, it } from "vite-plus/test";
import { exportFile } from "@dorks/shared";
import { uiApp } from "../src/http/ui";
import { createAutomation, getAutomation, updateAutomation } from "../src/services/automations";
import { createBuild, setBuildVar } from "../src/services/builds";
import { moveStatus } from "../src/services/cloudMove";
import { putMcpServer } from "../src/services/mcpServers";
import { setSecret } from "../src/services/settings";
import { insert, update } from "../src/db";
import { CloudImportStandIn } from "./fixtures/cloudImport";
import { harness } from "./harness";

// Move to cloud (services/cloudMove.ts, docs/move-to-cloud.md) against the reference import endpoint (fixtures/cloudImport.ts): the
// export the cloud receives is valid and complete, secrets arrive sealed and open only with the import's key, an interrupted upload
// resumes where the cloud stands, and afterwards this Mac's automations are off.

const CLOUD = "https://cloud.test";
const ORG = "org_acme";

function setup() {
  const cloud = new CloudImportStandIn({ orgId: ORG, macId: "mac_1" });
  const h = harness({
    fetch: ((input: string | URL | Request, init?: RequestInit) => cloud.handle(new Request(input instanceof Request ? input.url : String(input), init))) as typeof fetch,
    config: { cloudUrl: CLOUD },
  });
  update(h.app.db, "settings", { id: 1 }, { cloudMacId: "mac_1", cloudOrgId: ORG });
  const ui = uiApp(h.app);
  const call = (method: string, path: string, body?: unknown) =>
    ui.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { authorization: `Bearer ${h.app.cfg.ownerToken}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { cloud, h, call };
}

/** A sleeping session with `n` transcript events (dense seqs from 1). */
function session(h: ReturnType<typeof harness>, n: number, text: (i: number) => string) {
  const id = h.seed("sleeping");
  for (let i = 1; i <= n; i++) insert(h.app.db, "events", { dorkId: id, seq: i, ts: 1000 + i, body: JSON.stringify({ type: "assistant_message", messageId: `m${i}`, text: text(i) }) });
  return id;
}

/** The browser sign-in's handoff: the state this server opened, any code (the stand-in redeems every one). */
async function signIn(call: (method: string, path: string, body?: unknown) => Response | Promise<Response>) {
  const { url } = (await (await call("POST", "/api/cloud/sign-in")).json()) as { url: string };
  await call("POST", "/api/cloud/sign-in/finish", { code: "handoff-code", state: new URL(url).searchParams.get("state") });
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("move to cloud", () => {
  it("uploads a complete, valid export with sealed secrets, resumes a dropped part and turns local automations off", async () => {
    const { cloud, h, call } = setup();
    cloud.maxPartBytes = 4096; // several parts per session
    const a = session(h, 40, (i) => `reply ${i} ${"x".repeat(200)}`);
    const b = session(h, 12, (i) => `short ${i} — ünïcödé ✓ 日本語 ${"é".repeat(400)}`); // UTF-8 heavier than its JS length
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    h.app.db.run("INSERT INTO images (id, dork_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, 5)", "img_1", b, "image/png", png);
    await setSecret(h.app, "API_KEY", "s3cret-value");
    await putMcpServer(h.app, "linear", { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin-456" } });
    const auto = createAutomation(h.app, { name: "daily", instructions: "Check CI.", triggers: [{ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app" }] });
    await signIn(call);

    cloud.dropNextPart = true;
    cloud.loseCommitAnswer = true; // the commit lands but its answer is lost: the Mac must find out, not fail
    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(200);
    await until(() => ["done", "failed"].includes(moveStatus(h.app).phase));
    const st = moveStatus(h.app);
    expect(st).toMatchObject({ phase: "done", orgId: ORG, sessions: { done: 2, total: 2 }, events: { total: 52 }, error: null });

    const file = exportFile.parse(cloud.file(st.importId!)); // what the cloud stored is a valid, gap-free export
    expect(file.sessions.map((s) => [s.id, s.events.count])).toEqual([
      [a, 40],
      [b, 12],
    ]);
    expect(file.events[a].map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(file.automations.map((x) => x.name)).toEqual(["daily"]);
    expect(file.images).toEqual([{ id: "img_1", dorkId: b, mime: "image/png", bytes: png.length, createdAt: 5 }]);
    expect(Buffer.from(file.imageData.img_1, "base64").equals(png)).toBe(true);
    expect(file.mcpServers[0]).toMatchObject({ name: "linear", headerNames: ["Authorization"], oauth: false });
    expect(JSON.stringify(file)).not.toContain("s3cret-value"); // sealed, never in clear
    expect(JSON.stringify(file)).not.toContain("lin-456");
    expect(cloud.opened).toEqual({
      variables: { API_KEY: "s3cret-value" },
      buildVars: {},
      mcp: { linear: { headers: { Authorization: "Bearer lin-456" }, env: {}, url: "https://mcp.linear.app/mcp" } },
    });
    expect(getAutomation(h.app, auto)?.enabled).toBe(false); // the cloud runs it now
    expect(((await (await call("GET", "/api/cloud/places")).json()) as { orgs: { servers: unknown[] }[] }).orgs[1].servers).toEqual([]); // the org left this Mac
    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(409);
  });

  it("copies the personal workspace into a paid team: builds with sealed variables, local sessions without their box, archived here after", async () => {
    const { cloud, h, call } = setup();
    update(h.app.db, "settings", { id: 1 }, { cloudOrgId: "personal-1" }); // this Mac serves the personal workspace
    cloud.runtime = "cloud"; // the team already runs in the cloud: the copy merges into it
    const boat = session(h, 3, (i) => `cloud ${i}`);
    update(h.app.db, "dorks", { id: boat }, { boxId: "box_9", claudeSessionId: "cs_9" });
    const local = session(h, 2, (i) => `local ${i}`);
    update(h.app.db, "dorks", { id: local }, { location: "local", boxId: `local-${local}`, claudeSessionId: "cs_local" });
    const build = createBuild(h.app, { name: "Web", setupScript: "pnpm i", repos: [{ repo: "octo/app" }] });
    await setBuildVar(h.app, build, "NPM_TOKEN", { value: "npm-secret-1", secret: true, buildTime: true });
    update(h.app.db, "dorks", { id: boat }, { buildId: build });
    await signIn(call);

    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(200);
    await until(() => ["done", "failed"].includes(moveStatus(h.app).phase));
    const st = moveStatus(h.app);
    expect(st).toMatchObject({ phase: "done", orgId: ORG, error: null });
    const file = exportFile.parse(cloud.file(st.importId!));
    expect(file.builds).toMatchObject([{ id: build, name: "Web", setupScript: "pnpm i", vars: [{ name: "NPM_TOKEN", secret: true, buildTime: true }] }]);
    expect(file.sessions.find((s) => s.id === boat)).toMatchObject({ location: "cloud", boxId: "box_9", claudeSessionId: "cs_9", buildId: build });
    expect(file.sessions.find((s) => s.id === local)).toMatchObject({ location: "local", boxId: null, claudeSessionId: null });
    expect(JSON.stringify(file)).not.toContain("npm-secret-1");
    expect(cloud.opened?.buildVars).toEqual({ "Web.NPM_TOKEN": "npm-secret-1" });
    // The personal workspace stays on this Mac; what moved is archived here so it is not listed twice.
    expect(h.app.db.all<{ archived: number }>("SELECT archived FROM dorks WHERE id IN (?, ?)", boat, local).map((r) => r.archived)).toEqual([1, 1]);
    // The cloud owns the box now: deleting the archived copy here must not destroy it.
    expect(h.app.db.get<{ box_id: string | null; claude_session_id: string | null }>("SELECT box_id, claude_session_id FROM dorks WHERE id = ?", boat)).toEqual({
      box_id: null,
      claude_session_id: null,
    });
    expect((await call("DELETE", `/api/dorks/${boat}`)).status).toBeLessThan(300);
    await h.settle();
    expect(h.box.calls).not.toContain("delete");
  });

  it("refuses to copy a team this Mac does not serve into another org", async () => {
    const { h, call } = setup();
    update(h.app.db, "settings", { id: 1 }, { cloudOrgId: "org_other" });
    await signIn(call);
    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(400);
  });

  it("freezes this Mac while it moves: no message or automation run lands meanwhile", async () => {
    const { cloud, h, call } = setup();
    const a = session(h, 2, (i) => `t${i}`);
    const auto = createAutomation(h.app, { name: "daily", instructions: "Check CI.", triggers: [{ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app" }] });
    await signIn(call);
    let release!: () => void;
    cloud.hold = new Promise((r) => (release = r));
    await call("POST", "/api/cloud/move", { orgId: ORG });
    await until(() => moveStatus(h.app).phase === "uploading");
    const msg = await call("POST", `/api/dorks/${a}/messages`, { text: "one more thing" });
    expect([msg.status, JSON.stringify(await msg.json())]).toEqual([409, expect.stringContaining("moving to Dorks Cloud")]);
    expect((await call("POST", `/api/automations/${auto}/runs`)).status).not.toBe(201);
    expect(h.app.db.all("SELECT 1 FROM dorks")).toHaveLength(1);
    release();
    await until(() => moveStatus(h.app).phase === "done");
    expect((await call("POST", `/api/dorks/${a}/messages`, { text: "one more thing" })).status).toBe(200); // free again once it moved
  });

  it("after a restart mid-commit, asks the cloud and finishes the move it committed", async () => {
    const { cloud, h, call } = setup();
    session(h, 1, () => "t");
    const auto = createAutomation(h.app, { name: "daily", instructions: "Check CI.", triggers: [{ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app" }] });
    await signIn(call);
    await call("POST", "/api/cloud/move", { orgId: ORG });
    await until(() => moveStatus(h.app).phase === "done");
    // As if the process died right after the commit landed: the record still says committing, automations are still on.
    const importId = moveStatus(h.app).importId;
    h.app.db.run("UPDATE meta SET value = ? WHERE key = 'cloud_move'", JSON.stringify({ ...moveStatus(h.app), phase: "committing", finishedAt: null }));
    updateAutomation(h.app, auto, { enabled: true });
    const h2 = { app: h.app };
    const { recoverMove, resetMoveStatus } = await import("../src/services/cloudMove");
    resetMoveStatus(h2.app);
    await recoverMove(h2.app);
    expect(moveStatus(h2.app)).toMatchObject({ phase: "done", importId });
    expect(getAutomation(h2.app, auto)?.enabled).toBe(false);
  });

  it("refuses while a session works", async () => {
    const { h, call } = setup();
    h.seed("working");
    await signIn(call);
    const r = await call("POST", "/api/cloud/move", { orgId: ORG });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/still working/);
    expect(moveStatus(h.app).phase).toBe("idle");
  });

  it("an export file for another key cannot be opened with this import's key", async () => {
    const { cloud, h, call } = setup();
    session(h, 2, (i) => `t${i}`);
    await setSecret(h.app, "API_KEY", "s3cret-value");
    await signIn(call);
    const created = (await (
      await cloud.handle(
        new Request(`${CLOUD}/v1/orgs/${ORG}/imports`, {
          method: "POST",
          headers: { authorization: `Bearer ${cloud.token}` },
          body: JSON.stringify({ format: "dorks-export", version: 1, source: { kind: "mac", macId: "mac_1" }, counts: { sessions: 1, events: 2 } }),
        }),
      )
    ).json()) as { importId: string; key: unknown };
    const res = await call("POST", "/api/cloud/export", { importId: created.importId, key: created.key });
    const file = exportFile.parse(await res.json());
    expect(file.events[file.sessions[0].id]).toHaveLength(2);
    const other = { ...file, importId: "imp_other" }; // the sealed value is bound to its import: moved to another one, it does not open
    const { openImportSealed } = await import("@dorks/shared");
    const imp = cloud.imports.get(created.importId)!;
    await expect((await openImportSealed(imp.privateJwk, other))("variable|API_KEY", file.variables[0].value)).rejects.toThrow();
    expect(await (await openImportSealed(imp.privateJwk, file))("variable|API_KEY", file.variables[0].value)).toBe("s3cret-value");
  });
});
