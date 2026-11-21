import { describe, expect, it } from "vite-plus/test";
import { AppFail } from "../src/app";
import { update } from "../src/db";
import { uiApp } from "../src/http/ui";
import { crewCall, type Caller } from "../src/services/crew";
import { updateSettings } from "../src/services/settings";
import { harness } from "./harness";

// Crews (docs/crew.md): who can reach which dork, a worker's turn end reaching its coordinator, and the external MCP endpoint.

const TOKEN = "owner-token-for-tests";
const OWNER: Caller = { owner: true };

async function crew() {
  const h = harness();
  await updateSettings(h.app, { claudeToken: "ct", githubConnected: true, boatKey: "bk" });
  const call = (caller: Caller, tool: string, args: Record<string, unknown> = {}) => crewCall(h.app, caller, tool, args);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e) => (e instanceof AppFail ? e.error.code : String(e)),
    );
  const coordinator = async () => ((await call(OWNER, "dork_create", { message: "Ship the billing revamp", coordinator: true })) as { id: string }).id;
  const worker = async (coord: string, message = "Add the invoices table") => ((await call({ dorkId: coord }, "dork_create", { message, repo: "acme/app" })) as { id: string }).id;
  let bseq = 0;
  /** The worker's agent answers and ends its turn, as the bridge would stream it. */
  const finishTurn = (id: string, text: string) => {
    h.app.db.tx(() => update(h.app.db, "dorks", { id }, { state: "working" }));
    h.push(id, [
      { t: "event", bseq: ++bseq, raw: { type: "assistant", message: { id: `m${bseq}`, content: [{ type: "text", text }] } } },
      { t: "event", bseq: ++bseq, raw: { type: "result", duration_ms: 1000, is_error: false } },
    ]);
  };
  return { h, call, code, coordinator, worker, finishTurn };
}

describe("crew scope", () => {
  it("a coordinator reaches only its own workers; a worker only its crew; a plain dork nothing", async () => {
    const c = await crew();
    const a = await c.coordinator();
    const b = await c.coordinator();
    const wa = await c.worker(a);
    const wa2 = await c.worker(a, "Add the API");
    const wb = await c.worker(b);
    const plain = c.h.seed("idle");

    expect(c.h.dork(a).kind).toBe("coordinator");
    expect(c.h.dork(wa).parentId).toBe(a);
    // The worker's first message says who sent it.
    expect(c.h.events(wa).find((e) => e.body.type === "user_message")?.body).toMatchObject({ from: { id: a } });

    expect(await c.code(c.call({ dorkId: a }, "dork_get", { id: wa }))).toBe("ok");
    expect(await c.code(c.call({ dorkId: a }, "dork_get", { id: wb }))).toBe("not_found");
    expect(await c.code(c.call({ dorkId: a }, "dork_send", { id: plain, text: "hi" }))).toBe("not_found");
    expect(await c.code(c.call({ dorkId: a }, "dork_create", { message: "x", coordinator: true }))).toBe("forbidden");
    expect(await c.code(c.call({ dorkId: a }, "dork_delete", { id: wa }))).toBe("forbidden");
    const listed = (await c.call({ dorkId: a }, "dork_list")) as { dorks: { id: string }[] };
    expect(listed.dorks.map((d) => d.id).sort()).toEqual([wa, wa2].sort());

    expect(await c.code(c.call({ dorkId: wa }, "dork_create", { message: "x", repo: "acme/app" }))).toBe("forbidden");
    expect(await c.code(c.call({ dorkId: wa }, "dork_send", { id: wa2, text: "I own the schema" }))).toBe("ok");
    expect(await c.code(c.call({ dorkId: wa }, "dork_send", { id: wb, text: "hi" }))).toBe("not_found");
    const crewOfWa = (await c.call({ dorkId: wa }, "dork_list")) as { dorks: { id: string; role?: string }[] };
    expect(crewOfWa.dorks.map((d) => [d.id, d.role])).toEqual([
      [a, "coordinator"],
      [wa2, "worker"],
    ]);

    expect(await c.code(c.call({ dorkId: plain }, "dork_list"))).toBe("forbidden");
  });

  it("caps live workers per coordinator, and archiving the coordinator archives its crew", async () => {
    const c = await crew();
    const a = await c.coordinator();
    const ws = [];
    for (let i = 0; i < 8; i++) ws.push(await c.worker(a, `task ${i}`));
    expect(await c.code(c.call({ dorkId: a }, "dork_create", { message: "one more", repo: "acme/app" }))).toBe("limit");
    // Archiving one makes room for another, but bringing the archived one back is refused while the crew is full.
    await c.call({ dorkId: a }, "dork_archive", { id: ws[0] });
    await c.worker(a, "replacement");
    expect(await c.code(c.call({ dorkId: a }, "dork_archive", { id: ws[0], archived: false }))).toBe("limit");
    await c.call(OWNER, "dork_archive", { id: a });
    expect(ws.every((w) => c.h.dork(w).archived)).toBe(true);
    // A late tool call from the archived coordinator cannot bring a crew back.
    expect(await c.code(c.call({ dorkId: a }, "dork_create", { message: "late", repo: "acme/app" }))).toBe("archived");
    expect(await c.code(c.call({ dorkId: a }, "dork_archive", { id: ws[1], archived: false }))).toBe("archived");
    expect(await c.code(c.call({ dorkId: a }, "dork_send", { id: ws[1], text: "wake up" }))).toBe("archived");
    expect(await c.code(c.call({ dorkId: a }, "dork_list"))).toBe("ok");
  });
});

describe("reports", () => {
  it("a worker's final answer reaches its coordinator as one notify turn, with a crew card", async () => {
    const c = await crew();
    const a = await c.coordinator();
    const w = await c.worker(a);
    c.finishTurn(w, "Opened https://github.com/acme/app/pull/7; tests pass.");
    expect(c.h.hasTimer(a, "crew_notify")).toBe(true);
    // A coordinator with a report on its way is not settled yet, so dork_wait keeps waiting for it to read it.
    c.h.app.db.tx(() => update(c.h.app.db, "dorks", { id: a }, { state: "idle" }));
    expect(((await c.call(OWNER, "dork_get", { id: a })) as { dork: { settled: boolean } }).dork.settled).toBe(false);
    c.h.timer(a, "crew_notify");
    const notify = c.h.cmds(a).find((x) => x.kind === "notify");
    expect(notify?.text).toContain('<dorks-event source="crew">');
    expect(notify?.text).toContain("Opened https://github.com/acme/app/pull/7; tests pass.");
    expect(c.h.events(a).find((e) => e.body.type === "crew")?.body).toMatchObject({ type: "crew", direction: "in", kind: "report", peer: { id: w } });

    // What the coordinator (and the owner over MCP) reads back.
    const got = (await c.call({ dorkId: a }, "dork_get", { id: w })) as { dork: { lastAnswer?: { outcome: string; text: string } } };
    expect(got.dork.lastAnswer).toMatchObject({ outcome: "done", text: "Opened https://github.com/acme/app/pull/7; tests pass." });

    // A plain dork's turn end goes nowhere.
    const plain = c.h.seed("working");
    c.finishTurn(plain, "done");
    expect(c.h.hasTimer(plain, "crew_notify")).toBe(false);
  });
});

describe("external MCP endpoint", () => {
  it("speaks JSON-RPC over POST /mcp with the owner token", async () => {
    const c = await crew();
    const ui = uiApp(c.h.app);
    type Reply = { result: { protocolVersion?: string; isError?: boolean; structuredContent?: { tool: string }; tools?: { name: string }[] } };
    const json = async (r: Response) => (await r.json()) as Reply;
    const rpc = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
      ui.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" })).status).toBe(403);
    expect((await ui.request("/mcp", { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);

    const init = await json(await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }));
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const tools = (await json(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).result.tools!.map((t) => t.name);
    expect(tools).toContain("dork_create");
    expect(tools).toContain("dork_delete");

    const created = await json(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dork_create", arguments: { message: "Fix the flaky test", repo: "acme/app" } } }));
    expect(created.result.isError).toBe(false);
    expect(created.result.structuredContent?.tool).toBe("dork_create");
    const bad = await json(await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dork_get", arguments: { id: "nope" } } }));
    expect(bad.result.isError).toBe(true);
  });
});
