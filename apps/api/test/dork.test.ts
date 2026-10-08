import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClientEvent } from "@dorks/shared";
import type { Dork } from "../src/dork";
import { autoBridge, harness, settle, SECRET_TOKEN, types, waitFor } from "./helpers";

const viewerOf = async (h: Awaited<ReturnType<typeof harness>>, after = 0) => {
  const ticket = await h.stub.issueTicket();
  const res = await h.stub.fetch(`http://do/stream?ticket=${ticket}&after=${after}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  const got: ClientEvent[] = [];
  ws.addEventListener("message", (m) => {
    got.push(JSON.parse(m.data as string));
  });
  return { ws, got, status: res.status };
};

describe("event stream", () => {
  it("replays after=N then streams live, with no gaps or dupes", async () => {
    const h = await harness();
    for (let i = 1; i <= 3; i++) await runInDurableObject(h.stub, (o: Dork) => void o.append({ type: "user_message", text: `m${i}` }));
    const a = await viewerOf(h, 1);
    await runInDurableObject(h.stub, (o: Dork) => void o.append({ type: "user_message", text: "m4" }));
    await settle();
    expect(a.got.map((e) => e.seq)).toEqual([2, 3, 4]);
    a.ws.close();
    await runInDurableObject(h.stub, (o: Dork) => void o.append({ type: "user_message", text: "m5" }));
    const b = await viewerOf(h, 4);
    await settle();
    expect(b.got.map((e) => e.seq)).toEqual([5]);
  });

  it("tickets are single-use and required", async () => {
    const h = await harness();
    const t = await h.stub.issueTicket();
    expect((await h.stub.fetch(`http://do/stream?ticket=${t}`, { headers: { Upgrade: "websocket" } })).status).toBe(101);
    expect((await h.stub.fetch(`http://do/stream?ticket=${t}`, { headers: { Upgrade: "websocket" } })).status).toBe(403);
    expect((await h.stub.fetch("http://do/stream", { headers: { Upgrade: "websocket" } })).status).toBe(403);
  });
});

describe("lifecycle: happy path", () => {
  it("create -> work -> idle -> sleep -> wake with the same claude session", async () => {
    const h = await harness();
    const viewer = await viewerOf(h);

    // create: box made, nothing delivered until the bridge reports ready
    await h.stub.create("fix the bug");
    expect((await h.status()).state).toBe("creating");
    expect(h.box.calls).toEqual(["create"]);
    expect(await h.hasTimer("watchdog")).toBe(true);

    const b1 = await h.bridge();
    expect(b1.status).toBe(101);
    const auto1 = autoBridge(b1);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    expect(types(b1).slice(0, 3)).toEqual(["hello", "configure", "user_message"]);
    const cfg = b1.frames.find((f) => f.t === "configure")!;
    expect(cfg).toMatchObject({ t: "configure", repo: { fullName: "o/r", branch: "agent/abc12345" }, resumeSessionId: null, ghToken: "ghs_installation" });
    expect((cfg as { env: Record<string, string> }).env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_TOKEN, CF_TOKEN: "cf-secret" });
    expect(await h.hasTimer("watchdog")).toBe(false);
    expect(await h.hasTimer("sleep")).toBe(true);
    expect(await h.hasTimer("gh_token")).toBe(true);
    expect((await h.status()).pendingMessages).toBe(0);

    // sleep: flush, pause, bridge closed, timers stopped
    await h.runTimer("sleep");
    expect((await h.status()).state).toBe("sleeping");
    expect(types(b1)).toContain("flush");
    expect(h.box.calls).toEqual(["create", "pause"]);
    await waitFor(() => expect(b1.closed()).toBe(true));
    auto1.stop();
    expect(await h.hasTimer("gh_token")).toBe(false);
    expect(await h.hasTimer("sleep")).toBe(false);

    // wake: only a message does it; same claude session is resumed
    await h.stub.sendMessage("now add tests");
    expect((await h.status()).state).toBe("waking");
    expect(h.box.calls).toEqual(["create", "pause", "resume"]);
    const b2 = await h.bridge();
    const auto2 = autoBridge(b2);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    expect(b2.frames.find((f) => f.t === "configure")).toMatchObject({ resumeSessionId: "claude-session-1" });
    expect(b2.frames.some((f) => f.t === "user_message" && f.text === "now add tests")).toBe(true);
    auto2.stop();

    // clients saw the whole story, in order, gaplessly
    await settle();
    const seqs = viewer.got.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const statuses = viewer.got.flatMap((e) => (e.type === "status" ? [e.state] : []));
    expect(statuses).toEqual(["working", "idle", "sleeping", "waking", "working", "idle"]);
  });
});

describe("lifecycle: no lost or duplicated messages", () => {
  it("queues messages sent during creation and delivers each once", async () => {
    const h = await harness();
    await h.stub.create("one");
    await h.stub.sendMessage("two");
    await h.stub.sendMessage("three");
    expect((await h.status()).pendingMessages).toBe(3);
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).pendingMessages).toBe(0));
    const delivered = b.frames.flatMap((f) => (f.t === "user_message" ? [f.text] : []));
    expect(new Set(delivered)).toEqual(new Set(["one", "two", "three"]));
  });

  it("redelivers unacked messages after a bridge blip", async () => {
    const h = await harness();
    await h.stub.create("first");
    const b1 = await h.bridge();
    b1.send({ t: "ready" }); // ready but never acks
    await waitFor(async () => expect((await h.status()).state).toBe("working"));
    expect((await h.status()).pendingMessages).toBe(1);
    b1.ws!.close(1001, "network drop");
    await waitFor(async () => expect(await h.hasTimer("watchdog")).toBe(true)); // bridge_lost arms the watchdog

    const b2 = await h.bridge();
    autoBridge(b2);
    await waitFor(async () => expect((await h.status()).pendingMessages).toBe(0));
    expect(b2.frames.some((f) => f.t === "user_message" && f.text === "first")).toBe(true);
    expect(await h.hasTimer("watchdog")).toBe(false);
  });

  it("steers mid-turn without leaving working", async () => {
    const h = await harness();
    await h.stub.create("start");
    const b = await h.bridge();
    b.send({ t: "ready" });
    await waitFor(async () => expect((await h.status()).state).toBe("working"));
    await h.stub.sendMessage("also do X");
    expect((await h.status()).state).toBe("working");
    await waitFor(() => expect(b.frames.filter((f) => f.t === "user_message")).toHaveLength(3)); // initial, initial again on ready... or steer
    expect(b.frames.some((f) => f.t === "user_message" && f.text === "also do X")).toBe(true);
  });

  it("rejects empty and oversized messages", async () => {
    const h = await harness();
    expect(await h.stub.sendMessage("   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await h.stub.sendMessage("x".repeat(50_001))).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("lifecycle: archive", () => {
  it("pauses immediately; archived dorks refuse messages; unarchive never wakes", async () => {
    const h = await harness();
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));

    await h.stub.setArchived(true);
    expect(await h.status()).toMatchObject({ state: "sleeping", archived: true });
    expect(await h.stub.sendMessage("hello?")).toMatchObject({ ok: false, code: "archived" });
    expect(h.summaries.at(-1)?.archivedAt).toEqual(expect.any(Number));

    const callsBefore = [...h.box.calls];
    await h.stub.setArchived(false);
    expect(await h.status()).toMatchObject({ state: "sleeping", archived: false });
    expect(h.box.calls).toEqual(callsBefore); // no resume
    expect(h.summaries.at(-1)?.archivedAt).toBeNull();
  });

  it("interrupts a running turn first", async () => {
    const h = await harness();
    await h.stub.create("long task");
    const b = await h.bridge();
    b.send({ t: "ready" }); // working, never goes idle
    await waitFor(async () => expect((await h.status()).state).toBe("working"));
    const auto = autoBridge(b);
    await h.stub.setArchived(true);
    expect(types(b).indexOf("interrupt")).toBeGreaterThan(-1);
    expect(types(b).indexOf("interrupt")).toBeLessThan(types(b).indexOf("flush"));
    expect((await h.status()).state).toBe("sleeping");
    auto.stop();
  });

  it("archiving during creation pauses once ready", async () => {
    const h = await harness();
    await h.stub.create("go");
    await h.stub.setArchived(true);
    expect((await h.status()).state).toBe("creating");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("sleeping"));
    expect(h.box.calls).toContain("pause");
  });
});

describe("lifecycle: failure and recovery", () => {
  it("box creation failure -> error; next message retries and reuses the named box", async () => {
    const h = await harness();
    h.box.failNext.add("create");
    await h.stub.create("go");
    expect((await h.status()).state).toBe("error");
    expect((await h.events()).some((e) => e.type === "error")).toBe(true);
    expect(await h.hasTimer("watchdog")).toBe(false);

    await h.stub.sendMessage("try again");
    expect((await h.status()).state).toBe("creating");
    expect(h.box.boxes.size).toBe(1);
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
  });

  it("watchdog turns a stuck wake into error; next message retries", async () => {
    const h = await harness();
    await h.stub.create("go");
    await h.runTimer("watchdog"); // bridge never showed up
    expect((await h.status()).state).toBe("sleeping"); // error pauses the box (no leaked billing), then the dork sleeps
    expect((await h.events()).some((e) => e.type === "error" && /timed out/.test((e as { message: string }).message))).toBe(true);
    expect(h.box.calls).toEqual(["create", "pause"]);
    await h.stub.sendMessage("retry");
    expect((await h.status()).state).toBe("waking"); // box exists -> resume, not create
    expect(h.box.calls).toEqual(["create", "pause", "resume"]);
  });

  it("agent crash -> error -> box paused -> next message wakes it on a fresh bridge", async () => {
    const h = await harness();
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    b.send({ t: "agent_exited", code: 1, stderrTail: "boom" });
    await waitFor(async () => expect((await h.status()).state).toBe("sleeping")); // error flushes and pauses the box
    expect((await h.events()).some((e) => e.type === "agent_exited")).toBe(true);
    expect(h.box.calls).toEqual(["create", "pause"]);

    await h.stub.sendMessage("keep going");
    expect(h.box.calls).toEqual(["create", "pause", "resume"]);
    const b2 = await h.bridge();
    autoBridge(b2);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    expect(b2.frames.some((f) => f.t === "configure" && f.resumeSessionId === "claude-session-1")).toBe(true);
  });

  it("a failed pause leaves error, not a false 'sleeping'", async () => {
    const h = await harness();
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    h.box.pause = async () => {
      throw new Error("injected pause failure"); // stays down: the retry from `error` fails too
    };
    await h.runTimer("sleep");
    expect((await h.status()).state).toBe("error");
  });

  it("missing onboarding surfaces a readable error", async () => {
    const h = await harness();
    const { OnboardingError } = await import("../src/lifecycle/deps");
    h.deps.runtime.resolve = async () => {
      throw new OnboardingError("Claude token not set");
    };
    await h.stub.create("go");
    expect((await h.status()).state).toBe("error");
    expect(await h.events()).toContainEqual(expect.objectContaining({ type: "error", message: "Claude token not set" }));
  });
});

describe("lifecycle: safety", () => {
  it("bridge needs the secret and cannot connect to a sleeping dork", async () => {
    const h = await harness();
    expect((await h.bridge("wrong")).status).toBe(403);
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    await h.runTimer("sleep");
    expect((await h.bridge()).status).toBe(409);
    expect((await h.status()).state).toBe("sleeping");
  });

  it("secrets never reach the event log, raw log, summaries or status", async () => {
    const h = await harness();
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    const dump = JSON.stringify([await h.events(), h.summaries, await h.status()]);
    for (const s of [SECRET_TOKEN, "cf-secret", "ghs_installation", "bridge-secret"]) expect(dump).not.toContain(s);
    const raw = await runInDurableObject(h.stub, (o: Dork) => JSON.stringify((o as unknown as { sql: SqlStorage }).sql.exec("SELECT json FROM raw").toArray()));
    for (const s of [SECRET_TOKEN, "cf-secret", "ghs_installation"]) expect(raw).not.toContain(s);
  });

  it("D1 mirror failures are retried instead of lost", async () => {
    const h = await harness();
    h.failSummary.on = true;
    await h.stub.create("go");
    expect(await h.hasTimer("summary")).toBe(true);
    h.failSummary.on = false;
    await h.runTimer("summary");
    expect(h.summaries.length).toBeGreaterThan(0);
    expect(h.summaries.at(-1)).toMatchObject({ status: "creating", boxId: expect.any(String) });
  });

  it("refreshes the github token while awake", async () => {
    const h = await harness();
    await h.stub.create("go");
    const b = await h.bridge();
    autoBridge(b);
    await waitFor(async () => expect((await h.status()).state).toBe("idle"));
    await h.runTimer("gh_token");
    expect(b.frames).toContainEqual({ t: "gh_token", token: "ghs_installation" });
    expect(await h.hasTimer("gh_token")).toBe(true); // re-armed
  });

  it("delete: box failure keeps the dork so it can be retried; success wipes it", async () => {
    const h = await harness();
    await h.stub.create("go");
    h.box.failNext.add("delete");
    expect(await h.stub.destroy()).toMatchObject({ ok: false, code: "failed" });
    expect(await h.stub.destroy()).toMatchObject({ ok: true }); // retry succeeds
    expect(h.box.boxes.size).toBe(0);
    const res = await h.stub.fetch("http://do/bridge", { headers: { Upgrade: "websocket", Authorization: "Bearer bridge-secret" } });
    expect(res.status).toBe(404);
  });

  it("init refuses to re-bind a dork to another owner", async () => {
    const h = await harness();
    expect(await h.stub.init({ ...h.init, userId: "mallory" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await h.stub.init(h.init)).toMatchObject({ ok: true }); // same owner: idempotent
  });
});
