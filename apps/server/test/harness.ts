import type { ClientEvent, DorkState } from "@dorks/shared";

import type { App, Config } from "../src/app";
import { BoxNotFoundError, type BoxProvider } from "../src/core/box";
import { getDork, openCommands, runtimeOf, type CommandKind } from "../src/data";
import { Db, insert } from "../src/db";
import { bridgeSecret } from "../src/lib/bridgeAuth";
import { dispatch, enqueue, hasTimer } from "../src/lifecycle/dispatch";
import { fireTimer } from "../src/lifecycle/lifecycle";
import { Scheduler } from "../src/lifecycle/scheduler";
import * as bridge from "../src/services/bridge";
import { createApp } from "../src/server";
import type { SavedSnapshotInfo, SnapshotDriver } from "../src/core/snapshot";
import { makeAssets, type SnapshotAssets } from "../src/snapshot/assets";

export const NOW = 1_700_000_000_000;

export const testConfig = (over: Partial<Config> = {}): Config => ({
  dataDir: "/nonexistent", uiPort: 0, bridgePort: 0, publicUrl: "https://dorks.example", ownerToken: "owner-token-for-tests", bridgeSecretKey: "test-bridge-key",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"), boxProvider: "boat", uiOrigins: ["http://localhost:3000"], baseSnapshotId: "snap-1", ...over,
});

export interface FakeBox extends BoxProvider {
  calls: string[];
  failResumes: number;
  failPauses: number;
  failCreates: number;
  missing: Set<string>;
  created: { name: string; env: Record<string, string>; boatEnvironment?: string }[];
}

export function fakeBox(): FakeBox {
  const box: FakeBox = {
    calls: [], failResumes: 0, failPauses: 0, failCreates: 0, missing: new Set(), created: [],
    async createFromSnapshot(_s, o) {
      box.calls.push("create");
      if (box.failCreates-- > 0) throw new Error("create down");
      box.created.push({ name: o.name, env: o.env, boatEnvironment: o.boatEnvironment });
      return { id: `box-${o.name}` };
    },
    async resume(id) {
      box.calls.push("resume");
      if (box.missing.has(id)) throw new BoxNotFoundError();
      if (box.failResumes-- > 0) throw new Error("resume down");
    },
    async pause() {
      box.calls.push("pause");
      if (box.failPauses-- > 0) throw new Error("pause down");
    },
    async delete(id) {
      box.calls.push("delete");
      box.missing.add(id);
    },
  };
  return box;
}

export const testAssets = (bridge = "bridge-v1", installer = "installer-v1"): SnapshotAssets => makeAssets(new TextEncoder().encode(bridge), installer);

export interface FakeSnapshotDriver extends SnapshotDriver {
  calls: string[];
  /** Live build sandboxes, by id. */
  boxes: Map<string, { label: string }>;
  files: Map<string, string>;
  commands: string[];
  /** What the provider holds under each saved-snapshot name. */
  saved: Map<string, SavedSnapshotInfo>;
  /** Exit code of the next installer run (0 = success). */
  installExit: number;
  installStderr: string;
  installTimedOut: boolean;
  /** Fail the next call to these operations with this error. */
  failNext: Map<string, Error>;
  /** How many getSnapshot polls report `saving` before the save settles. */
  savingPolls: number;
  /** What a settled save reports. */
  saveResult: "ready" | "failed";
  deleteFails: boolean;
  /** Build runs: the detached setup's exit code and output, what the secret scan finds, and how sandboxes were created. */
  setupExit: number;
  setupOutput: string;
  scanHits: string;
  created: { from?: string; type?: string; labelKey?: string }[];
  killed: number[];
  deletedSnapshots: string[];
  maybeFail(op: string): void;
}

export function fakeSnapshotDriver(): FakeSnapshotDriver {
  let n = 0;
  const d: FakeSnapshotDriver = {
    calls: [], boxes: new Map(), files: new Map(), commands: [], saved: new Map(), installExit: 0, installStderr: "", installTimedOut: false,
    failNext: new Map(), savingPolls: 0, saveResult: "ready", deleteFails: false,
    setupExit: 0, setupOutput: "", scanHits: "", created: [], killed: [], deletedSnapshots: [],
    maybeFail(op) {
      const e = d.failNext.get(op);
      if (e) {
        d.failNext.delete(op);
        throw e;
      }
    },
    async listBuildSandboxes(label, _labelKey) {
      d.calls.push("list");
      return [...d.boxes].filter(([, b]) => b.label === label).map(([id]) => ({ id }));
    },
    async createBuildSandbox({ label, from, type, labelKey }) {
      d.calls.push("create");
      d.created.push({ from, type, labelKey });
      d.maybeFail("create");
      const id = `bx_build${++n}`;
      d.boxes.set(id, { label });
      return { id };
    },
    async waitReady() {
      d.calls.push("waitReady");
      d.maybeFail("waitReady");
    },
    async writeFile(_id, path, content) {
      d.calls.push("writeFile");
      d.files.set(path, content);
    },
    async run(_id, command) {
      d.calls.push("run");
      d.commands.push(command);
      if (command.includes("boat-install.sh")) return { exitCode: d.installExit, stdout: "", stderr: d.installStderr, timedOut: d.installTimedOut };
      if (command.includes("/tmp/dorks-scan")) return { exitCode: 0, stdout: d.scanHits, stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    async saveSnapshot(id, name) {
      d.calls.push("save");
      d.maybeFail("save");
      d.saved.set(name, { name, status: "saving", sourceSandboxId: id });
    },
    async getSnapshot(name) {
      d.calls.push("getSnapshot");
      const s = d.saved.get(name);
      if (!s) return null;
      if (s.status === "saving") {
        if (d.savingPolls-- > 0) return { ...s };
        d.saved.set(name, { ...s, status: d.saveResult, error: d.saveResult === "failed" ? "disk full" : undefined });
      }
      return { ...d.saved.get(name)! };
    },
    async deleteSandbox(id) {
      d.calls.push("delete");
      if (d.deleteFails) throw new Error("delete down");
      d.boxes.delete(id);
    },
    async runDetached(_id, command) {
      d.calls.push("runDetached");
      d.commands.push(command);
      return { processId: 7, commandId: "cmd_1" };
    },
    async attach(_id, _pid, offsets, onOutput) {
      d.calls.push("attach");
      if (d.setupOutput) onOutput("stdout", d.setupOutput);
      return { t: "exit", exitCode: d.setupExit, offsets };
    },
    async killCommand(_id, pid) {
      d.killed.push(pid);
    },
    async deleteSnapshot(name) {
      d.deletedSnapshots.push(name);
      d.saved.delete(name);
    },
  };
  return d;
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fake of the network: routes by pathname (GitHub API in the tests). Unhandled requests fail the test loudly. */
export function fakeFetch(handler: Handler) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    return handler(url, init);
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

export function harness(opts: { fetch?: typeof fetch; config?: Partial<Config> } = {}) {
  const clock = { t: NOW };
  const box = fakeBox();
  // Tests never reach the real network: by default GitHub knows one user, and anything else fails loudly.
  const offline = fakeFetch((url) => (url.pathname === "/user" ? Response.json({ login: "agent-bot" }) : new Response("{}", { status: 404 })));
  const snapshotDriver = fakeSnapshotDriver();
  const assets = { current: testAssets() };
  const app: App = createApp(testConfig(opts.config), {
    db: new Db(), now: () => clock.t, fetch: opts.fetch ?? offline, getBox: async () => box,
    getSnapshotDriver: async () => snapshotDriver, snapshotAssets: async () => assets.current, sleep: async () => {},
  });
  const scheduler = new Scheduler(app);
  const db = app.db;

  const h = {
    app, box, clock, scheduler, snapshotDriver, assets,
    /** A dork row plus its runtime, directly. */
    seed(state: DorkState, o: { boxId?: string | null; archived?: boolean; bridgeSeenAt?: number; bridgeLost?: boolean; bridgeSeq?: number; opGen?: number; provider?: "claude" | "codex"; repo?: string } = {}) {
      const id = app.uuid();
      insert(db, "dorks", {
        id, title: "t", repo: o.repo ?? "o/r", branch: "agent/x", provider: o.provider ?? "claude", state, archived: o.archived ?? false,
        boxId: o.boxId === undefined ? "box-1" : (o.boxId ?? undefined), deleting: false, lastActivityAt: 1, createdAt: 1,
      });
      insert(db, "dork_runtime", {
        dorkId: id, bridgeSeq: o.bridgeSeq ?? 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: o.bridgeSeenAt ?? clock.t, bridgeLost: o.bridgeLost ?? false,
        opGen: o.opGen ?? 0, pauseRetries: 0,
      });
      return id;
    },
    dork: (id: string) => getDork(db, id)!,
    state: (id: string) => getDork(db, id)!.state,
    rt: (id: string) => runtimeOf(db, id),
    cmds: (id: string) => openCommands(db, id),
    kinds: (id: string) => openCommands(db, id).map((c) => c.kind).sort(),
    events: (id: string) => db.all("SELECT seq, body FROM events WHERE dork_id = ? ORDER BY seq", id).map((r) => ({ seq: r.seq as number, body: JSON.parse(r.body as string) as ClientEvent })),
    hasTimer: (id: string, name: string) => hasTimer(app, id, name),
    input: (id: string, i: Parameters<typeof dispatch>[2]) => db.tx(() => dispatch(app, id, i)),
    enqueue: (id: string, kind: CommandKind, text?: string) => db.tx(() => enqueue(app, id, kind, text)),
    /** What the UI does on a message, minus validation. */
    sendMessage: (id: string, text = "hi") =>
      db.tx(() => {
        enqueue(app, id, "user_message", text);
        dispatch(app, id, { t: "user_message" });
      }),
    /** Fires a state-machine timer now, as the scheduler would after claiming its row. */
    timer: (id: string, name: string) =>
      db.tx(() => {
        db.run("DELETE FROM timers WHERE owner = ? AND name = ?", id, name);
        fireTimer(app, id, name);
      }),
    push: (id: string, frames: unknown[]) => bridge.push(app, id, frames),
    connect: (id: string) => bridge.connect(app, id),
    heartbeat: (id: string) => bridge.heartbeat(app, id),
    frames: (id: string) => bridge.commandsFor(app, id).map((c) => c.frame.t),
    secret: (id: string) => bridgeSecret(app.cfg.bridgeSecretKey, id),
    /** Runs everything due now (and the jobs it starts) until nothing is due. Does not move the clock. */
    async settle() {
      for (let i = 0; i < 50; i++) {
        const fired = scheduler.runDue();
        await scheduler.idle();
        if (!fired) return;
      }
      throw new Error("settle: timers keep firing");
    },
    async advance(ms: number) {
      clock.t += ms;
      await h.settle();
    },
  };
  return h;
}

export type Harness = ReturnType<typeof harness>;

export const ev = (bseq: number) => ({ t: "event", bseq, raw: { type: "assistant", message: { id: `m${bseq}`, content: [{ type: "text", text: `t${bseq}` }] } } });

