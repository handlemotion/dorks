import { describe, expect, it } from "vite-plus/test";
import { BridgeSession } from "../src/http/bridgeWs";
import { updateSettings } from "../src/services/settings";
import { WsTransport, type CommandEntry } from "../../../infra/bridge/src/transport";
import { ev, harness, type Harness } from "./harness";

// The real bridge transport (infra/bridge) talking to the real session and services, joined by an in-process "socket".

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await tick(2);
  }
};

function loopback(h: Harness) {
  const sockets: LoopbackWS[] = [];
  class LoopbackWS {
    readyState = 0;
    onopen?: () => void;
    onmessage?: (m: { data: string }) => void;
    onerror?: () => void;
    onclose?: (e: { code: number }) => void;
    private session?: BridgeSession;
    constructor(readonly url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.session = new BridgeSession(h.app, { send: (t) => void setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: t }), 0), close: (code) => this.end(code) });
        this.session.open();
        this.onopen?.();
      }, 0);
    }
    send(t: string) {
      setTimeout(() => void this.session?.onMessage(t), 0);
    }
    close() {
      this.end(1000);
    }
    /** Either side hangs up. */
    end(code: number) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.session?.close();
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  }
  return { WS: LoopbackWS as unknown as typeof WebSocket, sockets };
}

async function setup(state: Parameters<Harness["seed"]>[0], over: Parameters<Harness["seed"]>[1] = {}) {
  const h = harness({ config: { boxProvider: "sim", simHostKey: "k" } });
  const id = h.seed(state, over);
  const { WS, sockets } = loopback(h);
  const t = new WsTransport("ws://x/bridge", id, await h.secret(id), WS);
  return { h, id, t, sockets };
}

describe("bridge socket: authentication", () => {
  it("a wrong secret is refused and is fatal", async () => {
    const h = harness({ config: { boxProvider: "sim", simHostKey: "k" } });
    const id = h.seed("waking");
    const { WS } = loopback(h);
    const t = new WsTransport("ws://x/bridge", id, "0".repeat(64), WS);
    const err = await t.connect().catch((e) => e);
    expect(t.isFatal(err)).toBe(true);
    await t.close();
  });

  it("an unknown or deleting dork is refused", async () => {
    const h = harness({ config: { boxProvider: "sim", simHostKey: "k" } });
    const { WS } = loopback(h);
    const ghost = "no-such-dork";
    const t = new WsTransport("ws://x/bridge", ghost, await h.secret(ghost), WS);
    expect(t.isFatal(await t.connect().catch((e) => e))).toBe(true);
    const id = h.seed("idle");
    h.app.db.run("UPDATE dorks SET deleting = 1 WHERE id = ?", id);
    const t2 = new WsTransport("ws://x/bridge", id, await h.secret(id), WS);
    expect(t2.isFatal(await t2.connect().catch((e) => e))).toBe(true);
    await t.close();
    await t2.close();
  });
});

describe("bridge socket: rpc", () => {
  it("connect reports the stored bseq and queues configure; the snapshot carries it as a fetch marker, never a secret", async () => {
    const { h, id, t } = await setup("waking", { bridgeSeq: 7 });
    const seen: CommandEntry[][] = [];
    const off = t.subscribeCommands(
      (c) => seen.push(c),
      () => {},
    );
    expect((await t.connect()).afterBridgeSeq).toBe(7);
    await until(() => seen.some((c) => c.some((e) => e.frame.t === "fetch_configure")), "configure marker");
    expect(JSON.stringify(seen)).not.toContain("secret");
    off();
    await t.close();
    expect(h.state(id)).toBe("waking");
  });

  it("a sleeping dork cannot connect", async () => {
    const { t } = await setup("sleeping");
    const err = await t.connect().catch((e) => e);
    expect(t.isSleeping(err)).toBe(true);
    await t.close();
  });

  it("configure returns the secrets over the socket only", async () => {
    const { h, id, t } = await setup("waking", { provider: "claude", repo: "o/r" });
    await updateSettings(h.app, { claudeToken: "claude-token-xyz", githubToken: "gh-token-abc" });
    await h.app.db.tx(() => {});
    const { setSecret } = await import("../src/services/settings");
    await setSecret(h.app, "DEPLOY_TOKEN", "dp-123");
    const cfg = await t.configure();
    expect(cfg).toMatchObject({ t: "configure", provider: "claude", repo: { fullName: "o/r", branch: "agent/x" }, ghToken: "gh-token-abc", resumeSessionId: null });
    expect(cfg?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token-xyz", DEPLOY_TOKEN: "dp-123" });
    // Nothing secret was written to a command row or an event.
    const dump = JSON.stringify([h.cmds(id), h.events(id), h.app.db.all("SELECT * FROM commands")]);
    expect(dump).not.toContain("claude-token-xyz");
    expect(dump).not.toContain("gh-token-abc");
    expect(await t.ghToken()).toBe("gh-token-abc");
    await t.close();
  });

  it("configure is refused for an archived dork", async () => {
    const { h, t } = await setup("idle", { archived: true });
    await updateSettings(h.app, { claudeToken: "c", githubToken: "g" });
    expect(await t.configure()).toBeNull();
    await t.close();
  });

  it("push applies frames and reports a gap; errors are typed", async () => {
    const { h, id, t } = await setup("working");
    expect(await t.push([ev(1) as never, ev(2) as never])).toEqual({ ok: true });
    expect(await t.push([ev(5) as never])).toEqual({ ok: false, expectedBseq: 3 });
    expect(h.rt(id).bridgeSeq).toBe(2);
    const many = Array.from({ length: 501 }, (_, i) => ev(i + 3) as never);
    const err = await t.push(many).catch((e) => e);
    expect(t.errorCode(err)).toBe("too_many_frames");
    await t.close();
  });

  it("unknown ops are rejected", async () => {
    const { t } = await setup("working");
    const err = await (t as unknown as { rpc: (op: string) => Promise<unknown> }).rpc("nope").catch((e: unknown) => e);
    expect(t.errorCode(err)).toBe("invalid");
    await t.close();
  });

  it("PR subscriptions: subscribe/unsubscribe rpc and the pushed list", async () => {
    const { h, id, t } = await setup("working");
    const lists: unknown[] = [];
    const off = t.subscribeSubscriptions(
      (v) => lists.push(v),
      () => {},
    );
    await t.subscribePr({ repo: "O/R", number: 7 }, "auto");
    await until(() => lists.some((l) => Array.isArray(l) && l.length === 1), "subscription list");
    expect((lists.at(-1) as { repo: string; number: number }[])[0]).toMatchObject({ repo: "o/r", number: 7, source: "auto", status: "active" });
    expect(h.events(id).some((e) => e.body.type === "pr_opened")).toBe(true);
    await t.unsubscribePr({ repo: "o/r", number: 7 });
    await until(() => (lists.at(-1) as unknown[]).length === 0, "list emptied");
    off();
    await t.close();
  });
});

describe("bridge socket: a whole turn through the real transport", () => {
  it("message -> snapshot -> ack -> events -> turn_idle, and the snapshot follows every change", async () => {
    const { h, id, t } = await setup("waking");
    const snaps: CommandEntry[][] = [];
    t.subscribeCommands(
      (c) => snaps.push(c),
      () => {},
    );
    await t.connect();
    h.sendMessage(id, "do the thing"); // while waking: queued, not delivered
    await tick(20);
    expect(snaps.at(-1)?.map((c) => c.frame.t)).toEqual(["fetch_configure"]);
    await t.push([{ t: "ready" }]);
    await until(() => snaps.at(-1)?.some((c) => c.frame.t === "user_message") ?? false, "message delivered once ready");
    const msg = snaps.at(-1)!.find((c) => c.frame.t === "user_message")!;
    expect(msg.frame).toMatchObject({ t: "user_message", text: "do the thing" });
    await t.push([
      { t: "ack", id: msg.cid } as never,
      ev(1) as never,
      { t: "event", bseq: 2, raw: { type: "result", duration_ms: 5, is_error: false } } as never,
      { t: "event", bseq: 3, raw: { type: "system", subtype: "session_state_changed", state: "idle" } } as never,
    ]);
    await until(() => h.state(id) === "idle", "idle after the turn");
    await until(() => snaps.at(-1)?.every((c) => c.frame.t !== "user_message") ?? false, "acked message gone from the snapshot");
    expect(h.events(id).map((e) => e.body.type)).toContain("turn_complete");
    await t.close();
  });

  it("a dropped socket reconnects, fires onReconnect, and the snapshot is re-sent", async () => {
    const { h, id, t, sockets } = await setup("waking");
    const snaps: CommandEntry[][] = [];
    let reconnects = 0;
    t.onReconnect(() => reconnects++);
    t.subscribeCommands(
      (c) => snaps.push(c),
      () => {},
    );
    await t.connect();
    await until(() => snaps.length > 0, "first snapshot");
    const before = snaps.length;
    h.sendMessage(id, "queued while away");
    sockets[0].end(1006); // the tunnel dropped
    await until(() => reconnects === 1, "reconnect", 5000);
    await until(() => snaps.length > before, "snapshot after reconnect");
    expect(await t.connect()).toEqual({ afterBridgeSeq: 0 });
    await t.close();
  });
});
