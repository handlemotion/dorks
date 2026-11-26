import { describe, expect, it } from "vite-plus/test";
import { exportFile } from "@dorks/shared";
import { uiApp } from "../src/http/ui";
import { createAutomation, getAutomation } from "../src/services/automations";
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

const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("move to cloud", () => {
  it("uploads a complete, valid export with sealed secrets, resumes a dropped part and turns local automations off", async () => {
    const { cloud, h, call } = setup();
    cloud.maxPartBytes = 4096; // several parts per session
    const a = session(h, 40, (i) => `reply ${i} ${"x".repeat(200)}`);
    const b = session(h, 3, (i) => `short ${i}`);
    await setSecret(h.app, "API_KEY", "s3cret-value");
    await putMcpServer(h.app, "linear", { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin-456" } });
    const auto = createAutomation(h.app, { name: "daily", instructions: "Check CI.", triggers: [{ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app" }] });
    await call("POST", "/api/cloud/sign-in/verify", { email: "ada@example.com", code: "123456" });

    cloud.dropNextPart = true;
    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(200);
    await until(() => ["done", "failed"].includes(moveStatus(h.app).phase));
    const st = moveStatus(h.app);
    expect(st).toMatchObject({ phase: "done", orgId: ORG, sessions: { done: 2, total: 2 }, events: { total: 43 }, error: null });

    const file = exportFile.parse(cloud.file(st.importId!)); // what the cloud stored is a valid, gap-free export
    expect(file.sessions.map((s) => [s.id, s.events.count])).toEqual([
      [a, 40],
      [b, 3],
    ]);
    expect(file.events[a].map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(file.automations.map((x) => x.name)).toEqual(["daily"]);
    expect(file.mcpServers[0]).toMatchObject({ name: "linear", headerNames: ["Authorization"], oauth: false });
    expect(JSON.stringify(file)).not.toContain("s3cret-value"); // sealed, never in clear
    expect(JSON.stringify(file)).not.toContain("lin-456");
    expect(cloud.opened).toEqual({ variables: { API_KEY: "s3cret-value" }, mcp: { linear: { headers: { Authorization: "Bearer lin-456" }, env: {}, url: "https://mcp.linear.app/mcp" } } });
    expect(getAutomation(h.app, auto)?.enabled).toBe(false); // the cloud runs it now
    expect(((await (await call("GET", "/api/cloud/places")).json()) as { orgs: { servers: unknown[] }[] }).orgs[1].servers).toEqual([]); // the org left this Mac
    expect((await call("POST", "/api/cloud/move", { orgId: ORG })).status).toBe(409);
  });

  it("refuses while a session works", async () => {
    const { h, call } = setup();
    h.seed("working");
    await call("POST", "/api/cloud/sign-in/verify", { email: "ada@example.com", code: "123456" });
    const r = await call("POST", "/api/cloud/move", { orgId: ORG });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/still working/);
    expect(moveStatus(h.app).phase).toBe("idle");
  });

  it("an export file for another key cannot be opened with this import's key", async () => {
    const { cloud, h, call } = setup();
    session(h, 2, (i) => `t${i}`);
    await setSecret(h.app, "API_KEY", "s3cret-value");
    await call("POST", "/api/cloud/sign-in/verify", { email: "ada@example.com", code: "123456" });
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
