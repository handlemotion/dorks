import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge, SleepingError } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, FAKE_CLAUDE, FakeTransport, makeRemote, sleep, tmp, waitFor } from "./helpers";

const execFileP = promisify(execFile);
const BRIDGE_SECRET = "b".repeat(64);
const OAUTH = "sk-ant-oat01-UNIT-TEST-TOKEN";
const CLI_SECRET = "cli-secret-unit-test";
const GH_TOKEN = "ghs_unitTestInstallationToken";
let cli: string;
beforeAll(() => {
  cli = builtCli();
});

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(opts: { host?: Record<string, string>; transcript?: boolean; onSleeping?: () => void; env?: Record<string, string>; resume?: string | null; branch?: string; deltas?: number; connectError?: unknown; afterBridgeSeq?: number } = {}) {
  const remote = makeRemote();
  const state = tmp("state-");
  const work = tmp("work-");
  const report = join(tmp("report-"), "child.json");
  const logs: string[] = [];
  // The bridge's own env: what the box provides, plus things that must never reach the CLI.
  const hostEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: tmp("home-"),
    DORK_ID: "dork_test_1",
    BRIDGE_URL: "https://example.convex.cloud",
    BRIDGE_SECRET,
    SIM_HOST_KEY: "host-key-should-not-leak",
    BRIDGE_SECRET_KEY: "master-should-not-leak",
    DORKS_STATE_DIR: state,
    DORKS_WORKDIR: work,
    DORKS_GIT_BASE_URL: remote.baseUrl,
    CLAUDE_BIN: FAKE_CLAUDE,
    DELTA_BATCH_MS: "20",
    DORKS_BATCH_MS: "5",
    HEARTBEAT_MS: "60000",
    ...(opts.host ?? {}),
  };
  if (opts.resume && opts.transcript !== false) {
    // the session exists on this box's disk (like after a sleep/wake), so resume is allowed
    const dir = join(opts.env?.CLAUDE_CONFIG_DIR ?? join(hostEnv.HOME!, ".claude"), "projects", "-work");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${opts.resume}.jsonl`), "{}\n");
  }
  const cfg = loadConfig(hostEnv);
  const redactor = new Redactor();
  redactor.add(BRIDGE_SECRET);
  const t = new FakeTransport();
  t.afterBridgeSeq = opts.afterBridgeSeq ?? 0;
  t.connectError = opts.connectError ?? null;
  t.configureFrame = {
    t: "configure",
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, CF_TOKEN: CLI_SECRET, FAKE_CLAUDE_REPORT: report, FAKE_CLAUDE_DELTAS: String(opts.deltas ?? 3), FAKE_CLAUDE_GAP_MS: "10", ...(opts.env ?? {}) },
    ghToken: GH_TOKEN,
    repo: { fullName: "acme/demo", branch: opts.branch ?? "dork/abc" },
    resumeSessionId: opts.resume ?? null,
  };
  const bridge = new Bridge({ cfg, transport: t, log: makeLogger("t", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, cli], onSleeping: opts.onSleeping });
  cleanup.push(() => bridge.stop(500));
  return { bridge, t, remote, work, state, report, logs, redactor, hostEnv };
}

const readReport = (path: string) => waitFor(() => existsSync(path) && readFileSync(path, "utf8").endsWith("}") && JSON.parse(readFileSync(path, "utf8")), "child report");
const configure = (t: FakeTransport, cid = "cfg1") => t.emit([{ cid, frame: { t: "fetch_configure" } }]);
const msg = (id: string, text: string) => ({ cid: id, frame: { t: "user_message" as const, id, text } });
const rawTypes = (t: FakeTransport) => t.events().map((e) => ((e.raw as any).type === "system" ? `system/${(e.raw as any).subtype}` : (e.raw as any).type));

describe("bridge with a fake claude CLI", () => {
  it("configure: clones, checks out the dork branch, starts claude, acks, says ready", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    expect(s.t.of("ack").map((a) => a.id)).toContain("cfg1");
    const dir = join(s.work, "acme/demo");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: dir }).toString().trim()).toBe("dork/abc");
    const rep = await readReport(s.report);
    expect(rep.cwd).toContain("acme/demo");
    expect(rep.argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"]));
    expect(rep.argv).not.toContain("--resume");
  });

  it("clone URL and git config never contain the token; helper is in config", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const dir = join(s.work, "acme/demo");
    const cfgText = readFileSync(join(dir, ".git/config"), "utf8");
    expect(cfgText).not.toContain(GH_TOKEN);
    expect(cfgText).toContain("credential");
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir }).toString().trim()).toBe(`${s.remote.baseUrl}/acme/demo.git`);
    // nothing under the state or work dirs holds the token
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : statSync(join(d, n)).isSocket() ? [] : [join(d, n)]));
    for (const f of [...walk(s.state), ...walk(s.work)]) expect(readFileSync(f).includes(GH_TOKEN), f).toBe(false);
  });

  it("credential helper: git gets the in-memory token via the bridge, only for github.com, and a refresh swaps it", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const dir = join(s.work, "acme/demo");
    // async on purpose: the credential server lives in this process, so a blocking exec would deadlock
    const fill = async (host: string) => {
      const p = execFileP("git", ["credential", "fill"], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      p.child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
      return (await p).stdout;
    };
    expect(await fill("github.com")).toContain(`password=${GH_TOKEN}`);
    await expect(fill("evil.example.com")).rejects.toThrow(); // helper declines, git would prompt (disabled) and fail
    s.t.token = "ghs_refreshedToken123";
    s.t.emit([{ cid: "gh1", frame: { t: "fetch_gh_token" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "gh1"), "gh ack");
    expect(await fill("github.com")).toContain("password=ghs_refreshedToken123");
    expect(existsSync(join(s.state, "cred.sock"))).toBe(true);
  });

  it("secrets reach only the claude child: not the bridge env, and BRIDGE_SECRET never reaches claude", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const rep = await readReport(s.report);
    expect(rep.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(rep.env.CF_TOKEN).toBe(CLI_SECRET);
    expect(rep.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    for (const k of ["BRIDGE_SECRET", "BRIDGE_URL", "DORK_ID", "SIM_HOST_KEY", "BRIDGE_SECRET_KEY", "DORKS_STATE_DIR", "CLAUDE_BIN"]) expect(rep.envKeys, k).not.toContain(k);
    expect(JSON.stringify(rep.env)).not.toContain(BRIDGE_SECRET);
    // the bridge's own env (the one we passed and process.env) never received them
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(OAUTH);
    expect(process.env.CF_TOKEN).toBeUndefined();
    expect(s.hostEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("a configured env var with a reserved name cannot smuggle bridge identity into the child", async () => {
    const s = await setup({ env: { BRIDGE_SECRET: "evil", DORKS_STATE_DIR: "x" } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const rep = await readReport(s.report);
    expect(rep.envKeys).not.toContain("BRIDGE_SECRET");
    expect(rep.envKeys).not.toContain("DORKS_STATE_DIR");
  });

  it("a turn streams delta/message/tool/result, acks the message once, and numbers events from afterBridgeSeq", async () => {
    const s = await setup({ afterBridgeSeq: 100 });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "add a readme")]);
    await waitFor(() => rawTypes(s.t).filter((x) => x === "system/session_state_changed").length >= 2, "turn idle");
    await s.bridge.outbox.drained();
    const types = rawTypes(s.t);
    for (const need of ["system/init", "stream_event", "assistant", "user", "result"]) expect(types, need).toContain(need);
    expect(types).not.toContain("system/status"); // chatter filtered
    expect(s.t.of("ack").filter((a) => a.id === "m1")).toHaveLength(1);
    const seqs = s.t.events().map((e) => e.bseq);
    expect(seqs[0]).toBe(101);
    expect(seqs).toEqual(seqs.map((_, i) => 101 + i)); // dense, no gaps
    const idle = s.t.events().filter((e) => (e.raw as any).state === "idle");
    expect(idle.length).toBeGreaterThan(0); // the normalizer needs it to leave `working`
    // user message written as stream-json: the fake echoed it back as the final text
    const assistant = s.t.events().find((e) => (e.raw as any).type === "assistant")!;
    expect(JSON.stringify(assistant.raw)).toContain("Done: add a readme");
  });

  it("dedupes a re-delivered user message by id (no second turn), and re-acks only if needed", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "once")]);
    s.t.emit([msg("m1", "once")]);
    s.t.emit([msg("m1", "once")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    await sleep(200);
    expect(rawTypes(s.t).filter((x) => x === "result")).toHaveLength(1);
    expect(s.t.of("ack").filter((a) => a.id === "m1")).toHaveLength(1);
  });

  it("dedupe survives a bridge restart (journal): a message already written is acked, not re-run", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "once")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    await s.bridge.stop(500);

    // new process, same state dir: the backend redelivers m1 because the first ack never landed
    const logs: string[] = [];
    const t2 = new FakeTransport();
    t2.configureFrame = s.t.configureFrame;
    const redactor = new Redactor();
    const b2 = new Bridge({ cfg: loadConfig({ ...s.hostEnv }), transport: t2, log: makeLogger("t2", redactor, (l) => logs.push(l)), redactor, baseEnv: s.hostEnv, selfCommand: [process.execPath, cli] });
    cleanup.push(() => b2.stop(500));
    await b2.start();
    t2.emit([{ cid: "cfg2", frame: { t: "fetch_configure" } }, msg("m1", "once")]);
    await waitFor(() => t2.of("ack").some((a) => a.id === "m1"), "re-ack");
    await sleep(150);
    expect(rawTypes(t2)).not.toContain("result");
  });

  it("a message that arrives before the agent is up is processed once configure finishes", async () => {
    const s = await setup();
    await s.bridge.start();
    const early = msg("early", "hello early");
    s.t.emit([early]);
    await sleep(50);
    expect(s.t.of("ack")).toHaveLength(0);
    s.t.emit([early, { cid: "cfg1", frame: { t: "fetch_configure" } }]); // snapshots still carry the unacked message
    await waitFor(() => s.t.of("ack").some((a) => a.id === "early"), "early ack");
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
  });

  it("interrupt: sends the supported control_request, stops the turn, acks", async () => {
    const s = await setup({ deltas: 400 });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "long job")]);
    await waitFor(() => rawTypes(s.t).includes("stream_event"), "streaming");
    s.t.emit([msg("m1", "long job"), { cid: "int1", frame: { t: "interrupt" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "int1"), "interrupt ack");
    const res = await waitFor(() => s.t.events().find((e) => (e.raw as any).type === "result"), "result after interrupt");
    expect((res.raw as any).is_error).toBe(true);
    await waitFor(() => s.t.events().some((e) => (e.raw as any).state === "idle"), "idle");
  });

  it("flush: waits for idle, persists, acks, then sends flushed after every event", async () => {
    const s = await setup({ deltas: 15, env: { CLAUDE_CONFIG_DIR: join(tmp("cc-"), ".claude") } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "work")]);
    await waitFor(() => rawTypes(s.t).includes("stream_event"), "streaming");
    s.t.emit([msg("m1", "work"), { cid: "fl1", frame: { t: "flush" } }]);
    await waitFor(() => s.t.of("flushed").length, "flushed");
    const order = s.t.frames.map((f) => (f.t === "event" ? `e:${(f.raw as any).type}:${(f.raw as any).state ?? ""}` : f.t));
    const flushedAt = order.indexOf("flushed");
    expect(order.indexOf("ack")).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, flushedAt)).toContain("e:system:idle"); // the turn finished before we reported flushed
    expect(order.slice(flushedAt + 1).filter((x) => x.startsWith("e:"))).toHaveLength(0);
    expect(s.t.of("ack").some((a) => a.id === "fl1")).toBe(true);
  });

  it("configure is idempotent: a re-sent configure keeps the same process and just says ready again", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const pid1 = (await readReport(s.report)).pid;
    configure(s.t, "cfg2");
    await waitFor(() => s.t.of("ready").length >= 2, "second ready");
    expect((await readReport(s.report)).pid).toBe(pid1);
    expect(s.t.of("ack").map((a) => a.id)).toEqual(expect.arrayContaining(["cfg1", "cfg2"]));
  });

  it("configure on an existing clone fetches and checks out; a branch that exists on the remote is tracked", async () => {
    const s = await setup({ branch: "dork/existing" });
    s.remote.sh(s.remote.bare, "branch", "dork/existing", "main");
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const dir = join(s.work, "acme/demo");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "dork/existing@{upstream}"], { cwd: dir }).toString().trim()).toBe("origin/dork/existing");
    // a second configure after a restart of the whole bridge reuses the clone
    await s.bridge.stop(500);
    const t2 = new FakeTransport();
    t2.configureFrame = s.t.configureFrame;
    const redactor = new Redactor();
    const b2 = new Bridge({ cfg: loadConfig(s.hostEnv), transport: t2, log: makeLogger("t2", redactor, () => {}), redactor, baseEnv: s.hostEnv, selfCommand: [process.execPath, cli] });
    cleanup.push(() => b2.stop(500));
    await b2.start();
    t2.emit([{ cid: "c", frame: { t: "fetch_configure" } }]);
    await waitFor(() => t2.of("ready").length, "ready after restart");
  });

  it("resumeSessionId is passed as --resume and the session id carries over", async () => {
    const s = await setup({ resume: "11111111-2222-3333-4444-555555555555" });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const rep = await readReport(s.report);
    expect(rep.argv).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555"]));
    s.t.emit([msg("m1", "hi")]);
    const init = await waitFor(() => s.t.events().find((e) => (e.raw as any).subtype === "init"), "init");
    expect((init.raw as any).session_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("agent_exited carries the exit code when the CLI dies, with a scrubbed stderr tail", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "crash")]);
    const ex = await waitFor(() => s.t.of("agent_exited")[0], "agent_exited");
    expect(ex.code).toBe(3);
    expect(typeof ex.stderrTail).toBe("string");
  });

  it("stderr is never logged and secrets echoed there are scrubbed from the exit report", async () => {
    const s = await setup({ env: { FAKE_CLAUDE_STDERR: "1" } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "stderr-echo")]);
    const ex = await waitFor(() => s.t.of("agent_exited")[0], "agent_exited");
    expect(ex.stderrTail).not.toContain(OAUTH);
    expect(ex.stderrTail).not.toContain(CLI_SECRET);
    expect(ex.stderrTail).toContain("[redacted]");
    expect(s.logs.join("\n")).not.toContain("echo-marker");
  });

  it("permission prompts from the CLI are denied so an unattended turn cannot hang", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "permission")]);
    await waitFor(() => JSON.stringify(s.t.events()).includes("permission:deny"), "denied");
    await waitFor(() => rawTypes(s.t).includes("result"), "turn finished");
  });

  it("repo setup failure is reported as agent_exited, not a hang", async () => {
    const s = await setup({ branch: "bad..branch" });
    await s.bridge.start();
    configure(s.t);
    const ex = await waitFor(() => s.t.of("agent_exited")[0], "agent_exited");
    expect(ex.stderrTail).toContain("setup failed");
    expect(s.t.of("ready")).toHaveLength(0);
  });

  it("connect refused with `sleeping` rejects start() so the CLI can exit 0", async () => {
    const s = await setup({ connectError: { data: { code: "sleeping" } } });
    await expect(s.bridge.start()).rejects.toBeInstanceOf(SleepingError);
  });

  it("a reconnect refused with `sleeping` asks the process to exit cleanly", async () => {
    let slept = 0;
    const s = await setup({ onSleeping: () => slept++ });
    await s.bridge.start();
    s.t.connectError = { data: { code: "sleeping" } };
    s.t.reconnect();
    await waitFor(() => slept === 1, "onSleeping");
  });

  it("after a reconnect the bridge re-handshakes, continues numbering from afterBridgeSeq and replays what the backend lacks", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "one")]);
    await waitFor(() => rawTypes(s.t).filter((x) => x === "system/session_state_changed").length >= 2, "turn 1");
    await s.bridge.outbox.drained();
    const delivered = s.t.events().map((e) => e.bseq);
    const stored = delivered.at(-4)!; // backend lost the last 3 events while disconnected
    s.t.afterBridgeSeq = stored;
    const before = s.t.connectCalls;
    s.t.reconnect();
    await waitFor(() => s.t.connectCalls > before, "re-connect");
    await waitFor(() => s.t.events().length >= delivered.length + 3, "replay");
    expect(s.t.events().slice(delivered.length).map((e) => e.bseq)).toEqual(delivered.filter((x) => x > stored));
    // new events continue after the highest number
    s.t.emit([msg("m2", "two")]);
    await waitFor(() => s.t.events().some((e) => e.bseq > delivered.at(-1)!), "continued numbering");
  });

  it("logs never contain the bridge secret, tokens or CLI secrets", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "hello")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    s.t.token = null;
    s.t.emit([{ cid: "gh1", frame: { t: "fetch_gh_token" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "gh1"), "gh");
    const all = s.logs.join("\n");
    for (const secret of [BRIDGE_SECRET, OAUTH, CLI_SECRET, GH_TOKEN]) expect(all).not.toContain(secret);
    expect(all.length).toBeGreaterThan(0);
  });

  it("resume: a session id with no transcript on this box starts fresh instead of crash-looping, and the waiting message is answered", async () => {
    const s = await setup({ resume: "99999999-aaaa-bbbb-cccc-dddddddddddd", transcript: false });
    await s.bridge.start();
    const m = msg("m1", "hello after a box rebuild");
    s.t.emit([m, { cid: "cfg1", frame: { t: "fetch_configure" } }]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn answered");
    const rep = await readReport(s.report);
    expect(rep.argv).not.toContain("--resume");
    expect(s.t.of("agent_exited")).toHaveLength(0);
    expect(JSON.stringify(s.t.events())).toContain("Done: hello after a box rebuild");
  });

  it("resume: if the CLI still says 'No conversation found' (exit at start), retry fresh once; nothing from the failed run is forwarded", async () => {
    const s = await setup({ resume: "88888888-aaaa-bbbb-cccc-dddddddddddd", env: { FAKE_CLAUDE_NO_SESSION: "start" } });
    await s.bridge.start();
    s.t.emit([msg("m1", "retry me"), { cid: "cfg1", frame: { t: "fetch_configure" } }]);
    await waitFor(() => rawTypes(s.t).includes("assistant"), "answered on a fresh session", 15000);
    expect(s.t.of("agent_exited")).toHaveLength(0);
    expect(JSON.stringify(s.t.events())).not.toContain("No conversation found");
    expect(JSON.stringify(s.t.events())).toContain("Done: retry me");
  });

  it("resume: a message already written to the doomed resumed CLI is replayed on the fresh session", async () => {
    const s = await setup({ resume: "77777777-aaaa-bbbb-cccc-dddddddddddd", env: { FAKE_CLAUDE_NO_SESSION: "message" } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "do not lose me")]);
    await waitFor(() => JSON.stringify(s.t.events()).includes("Done: do not lose me"), "replayed and answered", 15000);
    expect(s.t.of("agent_exited")).toHaveLength(0);
    expect(JSON.stringify(s.t.events())).not.toContain("No conversation found");
    expect(s.t.of("ack").filter((a) => a.id === "m1")).toHaveLength(1);
  });

  it("a transient configure failure is retried, not stranded", async () => {
    const s = await setup();
    s.t.configureFailures = 2;
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready after retries", 15000);
    expect(s.t.configureCalls).toBe(3);
    expect(s.t.of("ack").map((a) => a.id)).toContain("cfg1");
  });

  it("an interrupt that arrives while configure is still running is applied after the agent is up, not dropped", async () => {
    const s = await setup({ deltas: 400 });
    s.t.configureDelayMs = 300;
    await s.bridge.start();
    s.t.emit([{ cid: "cfg1", frame: { t: "fetch_configure" } }, { cid: "int1", frame: { t: "interrupt" } }]);
    await sleep(100);
    expect(s.t.of("ack").some((a) => a.id === "int1")).toBe(false); // deferred, not acked-and-dropped
    await waitFor(() => s.t.of("ack").some((a) => a.id === "int1"), "interrupt handled once the agent is up");
    const order = s.t.frames.map((f) => (f.t === "ack" ? `ack:${f.id}` : f.t));
    expect(order.indexOf("ack:int1")).toBeGreaterThan(order.indexOf("ready"));
  });

  it("flush that times out waiting for the turn interrupts it first, and echoes the flush cid in flushed", async () => {
    const s = await setup({ deltas: 1000, host: { DORKS_FLUSH_IDLE_WAIT_MS: "150" } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "very long job")]);
    await waitFor(() => rawTypes(s.t).includes("stream_event"), "streaming");
    s.t.emit([msg("m1", "very long job"), { cid: "fl9", frame: { t: "flush" } }]);
    const flushed = await waitFor(() => s.t.of("flushed")[0], "flushed", 15000);
    expect((flushed as { cid?: string }).cid).toBe("fl9");
    const res = s.t.events().find((e) => (e.raw as any).type === "result");
    expect((res!.raw as any).is_error).toBe(true); // the turn was interrupted before we reported flushed
    expect(s.t.frames.indexOf(res!)).toBeLessThan(s.t.frames.indexOf(flushed));
  });
});

