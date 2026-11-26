import type { CommandEntry } from "../src/transport";
import type { FromBridge } from "@dorks/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { S2 } from "../src/s2/s2";
import { S2Transport } from "../src/s2/transport";
import { FakeS2, ACCOUNT_URL, BASIN_URL, ROOT } from "./fixtures/fake-s2";
import { StandInWorker } from "./fixtures/s2-worker";
import { waitFor } from "./helpers";

// S2Transport against an in-memory s2 (test/fixtures/fake-s2.ts) and a stand-in Worker: the command cursor with out-of-order acks
// across a bridge crash, fencing, a lost acknowledgement, and normalization. test/s2-live.test.ts runs a real bridge on real s2.

const SECRET = "s".repeat(64);
const transports: S2Transport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.close();
});

function setup() {
  const fake = new FakeS2();
  fake.ciphers.add("basin");
  const admin = new S2({ token: ROOT, basin: "basin", accountUrl: ACCOUNT_URL, basinUrl: BASIN_URL, fetch: fake.fetch });
  const worker = new StandInWorker({ admin, org: "org1", session: "sess1", secret: SECRET, kek: "k".repeat(32) });
  const bridge = () => {
    const t = new S2Transport({
      dorkId: "sess1",
      secret: SECRET,
      workerUrl: "http://worker.test",
      log: () => {},
      fetch: (u, i) => worker.handle(new Request(u, i)),
      s2Fetch: (u, i) => fake.fetch(u, i),
    });
    transports.push(t);
    const seen: CommandEntry[][] = [];
    t.subscribeCommands(
      (c) => seen.push(c),
      () => {},
    );
    return { t, latest: () => seen.at(-1) ?? [] };
  };
  return { fake, worker, bridge };
}

const ack = (id: string): FromBridge => ({ t: "ack", id });
const ev = (bseq: number, raw: unknown): FromBridge => ({ t: "event", bseq, raw });
const echoes = (items: { kind: string }[]) => items.filter((i): i is { kind: "command"; cid: string } & typeof i => i.kind === "command").map((i) => (i as unknown as { cid: string }).cid);

describe("S2Transport", () => {
  it("acks out of order, survives a crash with nothing lost or echoed twice, and fences the old bridge out", async () => {
    const { worker, bridge } = setup();
    await worker.open();
    await worker.sendCommand("msg-0001", { t: "user_message", id: "msg-0001", text: "hi" });
    await worker.sendCommand("cfg-0001", { t: "fetch_configure" });
    await worker.sendCommand("int-0001", { t: "interrupt" });
    await worker.sendCommand("msg-0001", { t: "user_message", id: "msg-0001", text: "hi" }); // a retried append: same cid

    const a = bridge();
    expect(await a.t.connect()).toEqual({ afterBridgeSeq: 0 });
    await waitFor(() => a.latest().length === 3, "three commands delivered, the duplicate skipped");
    // The message waits for the agent; the configure and the interrupt after it are acked first.
    await a.t.push([ack("cfg-0001"), ev(1, { type: "system", subtype: "init", session_id: "s-1" }), ack("int-0001")]);

    // The box dies. A new bridge connects (the Worker fences again): only the unacked message comes back.
    const b = bridge();
    expect(await b.t.connect()).toEqual({ afterBridgeSeq: 0 }); // the init line wrote no client event
    await waitFor(() => b.latest().length === 1, "the unacked message redelivered");
    expect(b.latest()[0].cid).toBe("msg-0001");
    await expect(a.t.push([ev(2, { type: "result", duration_ms: 1 })])).rejects.toSatisfy((e) => a.t.isFatal(e)); // fenced: 412
    await b.t.push([ack("msg-0001"), ev(1, { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }] } }), ev(2, { type: "result", duration_ms: 5 })]);

    await worker.sendCommand("msg-0002", { t: "user_message", id: "msg-0002", text: "again" });
    await waitFor(() => b.latest().some((c) => c.cid === "msg-0002"), "a new message");
    await b.t.push([ack("msg-0002")]);

    // A third bridge: everything is acked, nothing comes back, and events continue after bseq 2.
    const c = bridge();
    expect(await c.t.connect()).toEqual({ afterBridgeSeq: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.latest()).toEqual([]);
    const items = await worker.transcript();
    expect(echoes(items).sort()).toEqual(["cfg-0001", "int-0001", "msg-0001", "msg-0002"]);
    const events = items.filter((i) => i.kind === "event").flatMap((i) => JSON.parse(i.body));
    expect(events.map((e: { type: string }) => e.type)).toEqual(["assistant_message", "turn_complete"]);
    expect(events[1]).toMatchObject({ outcome: "done", finalMessageId: "m1" });
    expect(worker.state.map((f) => f.t)).toEqual(expect.arrayContaining(["ack", "session", "preview"]));
  });

  it("retries a batch whose acknowledgement was lost without writing it twice", async () => {
    const { fake, worker, bridge } = setup();
    const a = bridge();
    await a.t.connect();
    fake.loseNextAck.add(worker.streams.events);
    await a.t.push([ev(1, { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "once" }] } })]);
    const items = (await worker.transcript()).filter((i) => i.kind === "event");
    expect(items).toHaveLength(1);
    expect((await worker.rawEvents()).filter((r) => r.headers?.[0]?.[1] === "ev")).toHaveLength(1);
  });

  it("keeps a failed push's normalization for the replay: the final message is still named, state is not lost", async () => {
    const { fake, worker, bridge } = setup();
    const a = bridge();
    await a.t.connect();
    const frames = [
      ev(1, { type: "system", subtype: "init", session_id: "s-9" }),
      ev(2, { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "answer" }] } }),
      ev(3, { type: "result", duration_ms: 7 }),
    ];
    const realFetch = fake.fetch;
    let appends = 0;
    // The first append lands, the second is refused for good: the writer fails, the transport reconnects.
    const failing = async (u: RequestInfo | URL, i?: RequestInit) =>
      i?.method === "POST" && String(u).includes("/records") && ++appends === 2 ? new Response(JSON.stringify({ code: "invalid" }), { status: 422 }) : realFetch(u, i);
    (fake as { fetch: typeof fetch }).fetch = failing as typeof fetch;
    await expect(a.t.push(frames)).rejects.toBeTruthy();
    (fake as { fetch: typeof fetch }).fetch = realFetch;
    await a.t.connect();
    await a.t.push(frames); // the outbox's retry
    const bodies = (await worker.transcript()).flatMap((i) => (i.kind === "event" ? JSON.parse(i.body) : []));
    expect(bodies).toEqual([
      { type: "assistant_message", messageId: "m1", text: "answer" },
      { type: "turn_complete", durationMs: 7, outcome: "done", finalMessageId: "m1" },
    ]);
    expect(worker.state.map((f) => f.t)).toEqual(["session", "preview"]);
  });

  it("writes a secure input's request and its answer to the transcript once each", async () => {
    const { worker, bridge } = setup();
    const req = { type: "input_request", requestId: "rq-1", title: "Key", fields: [{ name: "API_KEY", label: "API key" }] };
    const res = { type: "input_response", requestId: "rq-1", status: "provided", names: ["API_KEY"] };
    worker.rpcResult = (op, args) =>
      op !== "input"
        ? null
        : (args as { action: string }).action === "request"
          ? { requestId: "rq-1", status: "pending", event: req }
          : { requestId: "rq-1", status: "provided", names: ["API_KEY"], event: res };
    const a = bridge();
    await a.t.connect();
    expect(await a.t.input({ action: "request", title: "Key", fields: [] })).toEqual({ requestId: "rq-1", status: "pending" });
    await a.t.input({ action: "wait", requestId: "rq-1" });
    await a.t.input({ action: "wait", requestId: "rq-1" }); // a second wait returns the same answer
    const notes = (await worker.transcript()).flatMap((i) => (i.kind === "note" ? JSON.parse(i.body) : []));
    expect(notes).toEqual([req, res]);
  });

  it("names the turn's final message and reports turn boundaries to the Worker", async () => {
    const { worker, bridge } = setup();
    const a = bridge();
    await a.t.connect();
    await a.t.push([
      ev(1, { type: "system", subtype: "session_state_changed", state: "running" }),
      ev(2, { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "answer" }] } }),
      ev(3, { type: "result", duration_ms: 7 }),
      ev(4, { type: "system", subtype: "session_state_changed", state: "idle" }),
      { t: "agent_exited", code: 1, stderrTail: "boom" },
    ]);
    const items = await worker.transcript();
    const bodies = items.flatMap((i) => (i.kind === "event" || i.kind === "note" ? JSON.parse(i.body) : []));
    expect(bodies).toEqual([
      { type: "assistant_message", messageId: "m1", text: "answer" },
      { type: "turn_complete", durationMs: 7, outcome: "done", finalMessageId: "m1" },
      { type: "agent_exited", message: "agent exited (code 1): boom" },
    ]);
    expect(worker.state.map((f) => f.t)).toEqual(["turn_started", "preview", "turn_idle", "agent_exited"]);
  });
});
