import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import type { ClientEvent, ToBridge } from "@dorks/shared";
import { createApp } from "../src/app";
import type { Dork, DorkInit, DorkStatus } from "../src/dork";
import { SimBox } from "../src/lib/box";
import type { Deps, SummaryPatch } from "../src/lifecycle/deps";

export const SECRET_TOKEN = "sk-ant-oat01-SUPERSECRET";
export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export interface Harness {
  stub: DurableObjectStub<Dork>;
  box: SimBox;
  summaries: SummaryPatch[];
  deps: Deps;
  failSummary: { on: boolean };
  init: DorkInit;
  status: () => Promise<DorkStatus>;
  events: () => Promise<ClientEvent[]>;
  runTimer: (name: string) => Promise<void>;
  hasTimer: (name: string) => Promise<boolean>;
  bridge: (secret?: string) => Promise<Bridge>;
}
export interface Bridge {
  status: number;
  frames: ToBridge[];
  send: (f: unknown) => void;
  closed: () => boolean;
  ws?: WebSocket;
}

let n = 0;
export async function harness(opts: { sleepMinutes?: number } = {}): Promise<Harness> {
  const id = `dork-test-${++n}-${Math.random().toString(36).slice(2, 6)}`;
  const stub = env.DORK.get(env.DORK.idFromName(id));
  const box = new SimBox();
  const summaries: SummaryPatch[] = [];
  const failSummary = { on: false };
  const deps: Deps = {
    box,
    runtime: {
      resolve: async () => ({ claudeToken: SECRET_TOKEN, cliSecrets: { CF_TOKEN: "cf-secret" }, snapshotId: "snap-1", sleepMinutes: opts.sleepMinutes ?? 5 }),
      githubToken: async () => "ghs_installation",
    },
    summary: {
      update: async (_id, patch) => {
        if (failSummary.on) throw new Error("d1 down");
        summaries.push(patch);
      },
    },
  };
  const init: DorkInit = { dorkId: id, userId: "u1", repo: "o/r", branch: "agent/abc12345", bridgeSecret: "bridge-secret" };
  await runInDurableObject(stub, (o: Dork) => {
    o._deps = deps;
    o.init(init);
  });
  return {
    stub, box, summaries, deps, failSummary, init,
    status: async () => stub.status(),
    events: () => stub.eventsAfter(0),
    runTimer: (name) => stub.runTimer(name),
    hasTimer: (name) => runInDurableObject(stub, (o: Dork) => (o as unknown as { timers: { has(n: string): boolean } }).timers.has(name)),
    async bridge(secret = "bridge-secret") {
      const res = await stub.fetch("http://do/bridge", { headers: { Upgrade: "websocket", Authorization: `Bearer ${secret}` } });
      const frames: ToBridge[] = [];
      if (res.status !== 101) return { status: res.status, frames, send() {}, closed: () => true };
      const ws = res.webSocket!;
      ws.accept();
      let closed = false;
      ws.addEventListener("message", (m) => {
        frames.push(JSON.parse(m.data as string));
      });
      ws.addEventListener("close", () => {
        closed = true;
      });
      return { status: 101, frames, ws, send: (f) => ws.send(JSON.stringify(f)), closed: () => closed };
    },
  };
}

export const types = (b: Bridge) => b.frames.map((f) => f.t);
export const waitFor = (fn: () => unknown) => vi.waitFor(fn, { timeout: 2000, interval: 10 });

/** Scripted bridge: answers configure with ready, acks messages, and runs a turn (init -> reply -> result -> idle). */
export function autoBridge(b: Bridge, opts: { sessionId?: string } = {}) {
  let bseq = 0;
  let seen = 0;
  const ev = (raw: unknown) => b.send({ t: "event", bseq: ++bseq, raw });
  const turn = (text: string) => {
    ev({ type: "assistant", message: { id: `m${bseq}`, content: [{ type: "text", text }] } });
    ev({ type: "result", duration_ms: 10, is_error: false });
    ev({ type: "system", subtype: "session_state_changed", state: "idle" });
  };
  const pump = setInterval(() => {
    for (; seen < b.frames.length; seen++) {
      const f = b.frames[seen];
      if (f.t === "hello") bseq = Math.max(bseq, f.afterBridgeSeq); // contract: continue numbering above what the DO has
      if (f.t === "configure") {
        ev({ type: "system", subtype: "init", session_id: opts.sessionId ?? "claude-session-1" });
        b.send({ t: "ready" });
      }
      if (f.t === "user_message") {
        b.send({ t: "ack", id: f.id });
        turn(`reply to: ${f.text}`);
      }
      if (f.t === "flush") b.send({ t: "flushed" });
    }
  }, 5);
  return { stop: () => clearInterval(pump), turn, ev };
}

// ---- API-level ----
export async function call(app: ReturnType<typeof createApp>, path: string, init?: RequestInit & { cookie?: string }) {
  const ctx = createExecutionContext();
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:3000");
  const res = await app.fetch(new Request(`http://localhost:3000${path}`, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function signIn(app: ReturnType<typeof createApp>, sent: Record<string, string>, email: string) {
  await call(app, "/api/auth/email-otp/send-verification-otp", { method: "POST", body: JSON.stringify({ email, type: "sign-in" }) });
  const res = await call(app, "/api/auth/sign-in/email-otp", { method: "POST", body: JSON.stringify({ email, otp: sent[email] }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await (await call(app, "/api/me", { cookie })).json()) as { user: { id: string } };
  return { cookie, userId: me.user.id };
}
