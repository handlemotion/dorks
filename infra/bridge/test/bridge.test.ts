import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge, SleepingError } from "../src/bridge";
import { rpcCall } from "../src/rpc";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, FAKE_CLAUDE, fakeView, FakeTransport, makeRemote, sleep, tmp, waitFor } from "./helpers";

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
    expect(cfgText).not.toContain("credential"); // the helper is configured once, globally, for every repo
    const global = readFileSync(join(s.hostEnv.HOME!, ".gitconfig"), "utf8");
    expect(global).not.toContain(GH_TOKEN);
    expect(global).toContain('[credential "https://github.com"]');
    expect(global).toContain("credential --sock");
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir }).toString().trim()).toBe(`${s.remote.baseUrl}/acme/demo.git`);
    // nothing under the state or work dirs holds the token
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : statSync(join(d, n)).isSocket() ? [] : [join(d, n)]));
    for (const f of [...walk(s.state), ...walk(s.work), ...walk(s.hostEnv.HOME!)]) expect(readFileSync(f).includes(GH_TOKEN), f).toBe(false);
  });

  it("credential helper: git gets the in-memory token via the bridge in any repo, only for github.com, and a refresh swaps it", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const dir = join(s.work, "acme/demo");
    const other = join(s.work, "someone/else"); // a repo the agent cloned itself: it has no config of its own
    mkdirSync(other, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: other });
    // async on purpose: the credential server lives in this process, so a blocking exec would deadlock
    const fill = async (host: string, cwd = dir) => {
      const p = execFileP("git", ["credential", "fill"], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_GLOBAL: join(s.hostEnv.HOME!, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
      p.child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
      return (await p).stdout;
    };
    expect(await fill("github.com")).toContain(`password=${GH_TOKEN}`);
    expect(await fill("github.com", other)).toContain(`username=x-access-token\npassword=${GH_TOKEN}`);
    await expect(fill("evil.example.com")).rejects.toThrow(); // helper declines, git would prompt (disabled) and fail
    s.t.token = "ghs_refreshedToken123";
    s.t.emit([{ cid: "gh1", frame: { t: "fetch_gh_token" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "gh1"), "gh ack");
    expect(await fill("github.com", other)).toContain("password=ghs_refreshedToken123");
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
    const s = await setup({ connectError: { data: { code: "sleeping", message: "sleeping" } } });
    await expect(s.bridge.start()).rejects.toBeInstanceOf(SleepingError);
  });

  it("a reconnect refused with `sleeping` asks the process to exit cleanly", async () => {
    let slept = 0;
    const s = await setup({ onSleeping: () => slept++ });
    await s.bridge.start();
    s.t.connectError = { data: { code: "sleeping", message: "sleeping" } };
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

  it("sleep/wake: a new bridge process resumes the session the previous one wrote to disk", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([msg("m1", "first")]);
    const init = await waitFor(() => s.t.events().find((e) => (e.raw as any).subtype === "init"), "init");
    const sid = (init.raw as any).session_id as string;
    await waitFor(() => s.t.events().some((e) => (e.raw as any).state === "idle"), "idle");
    await s.bridge.stop(500);

    const t2 = new FakeTransport();
    t2.configureFrame = { ...s.t.configureFrame!, resumeSessionId: sid };
    const redactor = new Redactor();
    const b2 = new Bridge({ cfg: loadConfig(s.hostEnv), transport: t2, log: makeLogger("t2", redactor, () => {}), redactor, baseEnv: s.hostEnv, selfCommand: [process.execPath, cli] });
    cleanup.push(() => b2.stop(500));
    await b2.start();
    t2.emit([{ cid: "c2", frame: { t: "fetch_configure" } }]);
    await waitFor(() => t2.of("ready").length, "ready after wake");
    // the second child rewrites the report file when it starts
    const rep = await waitFor(async () => {
      const r = await readReport(s.report);
      return r.argv.includes("--resume") && r;
    }, "second child started with --resume");
    expect(rep.argv).toEqual(expect.arrayContaining(["--resume", sid]));
  });
});

describe("autonomy: notify frames", () => {
  const ENVELOPE = '<dorks-event source="github" kinds="ci_failed,comment" prs="acme/demo#12">\nCI failed on acme/demo#12 (attempt 1 of 2).\n  indented "quoted" line\n</dorks-event>';
  const notify = (id: string, text = ENVELOPE) => ({ cid: id, frame: { t: "notify" as const, id, text, kinds: ["ci_failed" as const, "comment" as const], prs: [{ repo: "acme/demo", number: 12 }] } });
  const lastResult = (t: FakeTransport) => (t.events().filter((e) => (e.raw as any).type === "result").at(-1)?.raw as any)?.result;

  it("writes the text to the agent verbatim as a user turn and acks it like a user message", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([notify("n1")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    expect(lastResult(s.t)).toBe(`Done: ${ENVELOPE}`);
    expect(s.t.of("ack").filter((a) => a.id === "n1")).toHaveLength(1);
  });

  it("dedupes a re-delivered notify by id, including across a bridge restart (shared journal)", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([notify("n1")]);
    s.t.emit([notify("n1")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    await sleep(150);
    expect(rawTypes(s.t).filter((x) => x === "result")).toHaveLength(1);
    expect(readFileSync(join(s.state, "messages.log"), "utf8").split("\n")).toContain("n1");
    await s.bridge.stop(500);

    const t2 = new FakeTransport();
    t2.configureFrame = s.t.configureFrame;
    const redactor = new Redactor();
    const b2 = new Bridge({ cfg: loadConfig({ ...s.hostEnv }), transport: t2, log: makeLogger("t2", redactor, () => {}), redactor, baseEnv: s.hostEnv, selfCommand: [process.execPath, cli] });
    cleanup.push(() => b2.stop(500));
    await b2.start();
    t2.emit([{ cid: "cfg2", frame: { t: "fetch_configure" } }, notify("n1")]);
    await waitFor(() => t2.of("ack").some((a) => a.id === "n1"), "re-ack");
    await sleep(150);
    expect(rawTypes(t2)).not.toContain("result");
  });

  it("an unacked notify waits for the agent and is delivered once configure finishes", async () => {
    const s = await setup();
    await s.bridge.start();
    s.t.emit([notify("n1")]);
    await sleep(50);
    expect(s.t.of("ack")).toHaveLength(0);
    s.t.emit([notify("n1"), { cid: "cfg1", frame: { t: "fetch_configure" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "n1"), "ack");
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
  });

  it("logs the kinds and PRs, never the text", async () => {
    const s = await setup();
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    s.t.emit([notify("n1", "<dorks-event>please-do-not-log-this-body</dorks-event>")]);
    await waitFor(() => rawTypes(s.t).includes("result"), "turn");
    const line = s.logs.find((l) => l.includes("notify delivered"));
    expect(line).toContain("ci_failed,comment");
    expect(line).toContain("acme/demo#12");
    expect(s.logs.join("\n")).not.toContain("please-do-not-log-this-body");
  });
});

describe("autonomy: local RPC", () => {
  const sockOf = (s: { state: string }) => join(s.state, "cred.sock");
  const ready = async (opts: Parameters<typeof setup>[0] = {}) => {
    const s = await setup(opts);
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    return s;
  };

  it("token: serves the current GitHub token for github.com only; unavailable before configure; refresh swaps it", async () => {
    const s = await setup();
    await s.bridge.start();
    await expect(rpcCall(sockOf(s), "token", { host: "github.com" })).rejects.toMatchObject({ code: "unavailable" });
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    expect(await rpcCall(sockOf(s), "token", { host: "github.com" })).toEqual({ token: GH_TOKEN });
    await expect(rpcCall(sockOf(s), "token", { host: "evil.example.com" })).rejects.toMatchObject({ code: "denied" });
    await expect(rpcCall(sockOf(s), "token", {})).rejects.toMatchObject({ code: "invalid" });
    s.t.token = "ghs_refreshedToken123";
    s.t.emit([{ cid: "gh1", frame: { t: "fetch_gh_token" } }]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "gh1"), "gh ack");
    expect(await rpcCall(sockOf(s), "token", { host: "github.com" })).toEqual({ token: "ghs_refreshedToken123" });
  });

  it("pr.sub / pr.unsub go to the backend with their source, and pr.list reads its own writes", async () => {
    const s = await ready();
    const ref = { repo: "acme/demo", number: 12 };
    expect(await rpcCall(sockOf(s), "pr.list")).toEqual([]);
    expect(await rpcCall(sockOf(s), "pr.sub", { ...ref, source: "auto" })).toEqual(ref);
    expect(await rpcCall(sockOf(s), "pr.sub", { repo: "acme/other", number: 3 })).toEqual({ repo: "acme/other", number: 3 }); // agent is the default source
    expect(s.t.prCalls).toEqual([
      { op: "sub", ref, source: "auto" },
      { op: "sub", ref: { repo: "acme/other", number: 3 }, source: "agent" },
    ]);
    expect((await rpcCall<any[]>(sockOf(s), "pr.list")).map((v) => `${v.repo}#${v.number}:${v.source}`)).toEqual(["acme/demo#12:auto", "acme/other#3:agent"]);
    await rpcCall(sockOf(s), "pr.unsub", ref);
    expect(s.t.prCalls.at(-1)).toEqual({ op: "unsub", ref });
    expect((await rpcCall<any[]>(sockOf(s), "pr.list")).map((v) => v.number)).toEqual([3]);
  });

  it("matches repos case-insensitively: the backend stores them lowercase, URLs keep their casing", async () => {
    const s = await ready();
    s.t.setSubscriptions([fakeView({ repo: "acme/demo", number: 12 })]);
    const mixed = { repo: "Acme/Demo", number: 12 };
    const t0 = Date.now();
    await rpcCall(sockOf(s), "pr.sub", mixed); // already in the list under its lowercase name: no waiting for a change that never comes
    expect(Date.now() - t0).toBeLessThan(1000);
    await rpcCall(sockOf(s), "pr.unsub", mixed);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.t.subscriptions).toEqual([]);
  });

  it("validates input before it reaches the backend", async () => {
    const s = await ready();
    for (const params of [{}, { repo: "acme", number: 1 }, { repo: "acme/demo", number: 0 }, { repo: "acme/demo", number: 1.5 }, { repo: "acme/demo", number: "12" }, { repo: "../etc", number: 1 }, { repo: "a/b/c", number: 1 }, { repo: "acme/demo", number: 1, source: "user" }, null]) {
      await expect(rpcCall(sockOf(s), "pr.sub", params), JSON.stringify(params)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(rpcCall(sockOf(s), "pr.unsub", { repo: "acme/demo" })).rejects.toMatchObject({ code: "invalid" });
    expect(s.t.prCalls).toEqual([]);
  });

  it("backend failures surface as coded errors without leaking details", async () => {
    const s = await ready();
    s.t.prError = { data: { code: "not_found", message: "not found" }, message: "secret internal detail" };
    const refused = (await rpcCall(sockOf(s), "pr.sub", { repo: "acme/demo", number: 1 }).catch((e) => e)) as Error;
    expect(refused).toMatchObject({ code: "failed", message: "the backend refused the request (not_found)" });
    s.t.prError = new Error("ECONNRESET with secret detail");
    const down = (await rpcCall(sockOf(s), "pr.unsub", { repo: "acme/demo", number: 1 }).catch((e) => e)) as Error;
    expect(down).toMatchObject({ code: "unavailable", message: "could not reach the backend" });
    expect(JSON.stringify([refused.message, down.message, s.logs])).not.toContain("secret");
  });

  it("pr.list waits for the first copy of the subscriptions, then serves the cache", async () => {
    const s = await setup();
    s.t.pushInitialSubscriptions = false;
    await s.bridge.start();
    const pending = rpcCall<any[]>(sockOf(s), "pr.list");
    await sleep(100);
    s.t.setSubscriptions([fakeView({ repo: "acme/demo", number: 1 })]);
    expect((await pending).map((v) => v.number)).toEqual([1]);
  });

  it("ignores a malformed list and keeps the last good one; reconnecting re-opens the subscription and picks up changes", async () => {
    const s = await ready();
    s.t.setSubscriptions([fakeView({ repo: "acme/demo", number: 1 })]);
    s.t.setSubscriptions([{ repo: 1 }] as any);
    expect((await rpcCall<any[]>(sockOf(s), "pr.list")).map((v) => v.number)).toEqual([1]);
    expect(s.logs.join("\n")).toContain("malformed subscription list");

    expect(s.t.subscriptionsWatchers).toBe(1);
    s.t.pushInitialSubscriptions = false; // the backend is slow to answer after the reconnect; the stale copy is still served
    s.t.reconnect();
    await waitFor(() => s.t.subscriptionsWatchers === 2, "re-subscribed");
    s.t.setSubscriptions([fakeView({ repo: "acme/demo", number: 1 }), fakeView({ repo: "acme/demo", number: 2 })]);
    expect((await rpcCall<any[]>(sockOf(s), "pr.list")).map((v) => v.number)).toEqual([1, 2]);
  });

  it("the agent's environment carries the socket path, and DORKS_REAL_GH, but no other DORKS_* variable", async () => {
    const s = await setup({ host: { DORKS_REAL_GH: "/opt/gh/bin/gh" } });
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    const rep = await readReport(s.report);
    expect(rep.env.DORKS_SOCK).toBe(sockOf(s));
    expect(rep.env.DORKS_REAL_GH).toBe("/opt/gh/bin/gh");
    expect(rep.envKeys.filter((k: string) => k.startsWith("DORKS_")).sort()).toEqual(["DORKS_REAL_GH", "DORKS_SOCK"]);
  });
});

describe("autonomy: hooks", () => {
  const sockOf = (s: { state: string }) => join(s.state, "cred.sock");
  const ready = async (opts: Parameters<typeof setup>[0] = {}) => {
    const s = await setup(opts);
    await s.bridge.start();
    configure(s.t);
    await waitFor(() => s.t.of("ready").length, "ready");
    return s;
  };
  const settingsOf = (s: { state: string }) => JSON.parse(readFileSync(join(s.state, "claude-settings.json"), "utf8"));
  /** Runs a hook the way Claude Code does: the settings file's command through a shell, the hook JSON on stdin, DORKS_SOCK in the environment. */
  const runHook = async (s: Awaited<ReturnType<typeof ready>>, event: "Stop" | "PostToolUse" | "SessionStart", input: object) => {
    const hook = settingsOf(s).hooks[event][0].hooks[0];
    const p = execFileP("sh", ["-c", hook.command], { env: { PATH: process.env.PATH, DORKS_SOCK: sockOf(s) } });
    p.child.stdin!.end(JSON.stringify({ session_id: "sess1", hook_event_name: event, ...input }));
    const { stdout } = await p;
    return stdout ? JSON.parse(stdout) : null;
  };
  const dir = (s: { work: string }) => join(s.work, "acme/demo");
  const commit = (s: { work: string; remote: ReturnType<typeof makeRemote> }, file: string) => {
    writeFileSync(join(dir(s), file), "x\n");
    s.remote.sh(dir(s), "add", ".");
    s.remote.sh(dir(s), "commit", "-q", "-m", file);
  };
  const notify = (id: string, kinds: ("ready" | "ci_failed")[]) => ({ cid: id, frame: { t: "notify" as const, id, text: "<dorks-event>…</dorks-event>", kinds, prs: [{ repo: "acme/demo", number: 12 }] } });

  it("writes the hook settings before the agent starts and passes them with --settings; the repo's own settings are left alone", async () => {
    const s = await ready();
    const file = join(s.state, "claude-settings.json");
    const rep = await readReport(s.report);
    expect(rep.argv.slice(rep.argv.indexOf("--settings"), rep.argv.indexOf("--settings") + 2)).toEqual(["--settings", file]);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const hooks = settingsOf(s).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    expect(hooks.Stop[0].hooks[0].command).toBe(`'${process.execPath}' '${cli}' dorks hook stop`);
    expect(hooks.PostToolUse[0].matcher).toBe("Bash");
    expect(hooks.SessionStart[0].matcher).toBe("startup|resume|compact");
    expect(existsSync(join(dir(s), ".claude"))).toBe(false); // nothing is written into the repo
  });

  it("writes the dorks MCP server config and passes it with --mcp-config, pointing the server at the bridge's socket", async () => {
    const s = await ready();
    const file = join(s.state, "claude-mcp.json");
    const rep = await readReport(s.report);
    expect(rep.argv.slice(rep.argv.indexOf("--mcp-config"), rep.argv.indexOf("--mcp-config") + 2)).toEqual(["--mcp-config", file]);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const server = JSON.parse(readFileSync(file, "utf8")).mcpServers.dorks;
    expect(server).toEqual({ type: "stdio", command: process.execPath, args: [cli, "dorks", "mcp"], env: { DORKS_SOCK: rep.env.DORKS_SOCK } });
    expect(existsSync(join(dir(s), ".mcp.json"))).toBe(false); // nothing is written into the repo
  });

  it("keeps --settings on a resumed session", async () => {
    const s = await ready({ resume: "11111111-2222-3333-4444-555555555555" });
    const rep = await readReport(s.report);
    expect(rep.argv).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555", "--settings", join(s.state, "claude-settings.json")]));
  });

  it("Stop: the command from the settings file blocks on unpushed work once, then lets the agent stop", async () => {
    const s = await ready();
    expect(await runHook(s, "Stop", { stop_hook_active: false })).toBeNull(); // the fresh dork branch has no commits yet
    commit(s, "a.txt");
    const blocked = await runHook(s, "Stop", { stop_hook_active: false });
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("branch dork/abc: 1 commit not pushed anywhere (no upstream)");
    expect(await runHook(s, "Stop", { stop_hook_active: true })).toBeNull();
    expect(await runHook(s, "Stop", { stop_hook_active: false })).toBeNull(); // raised already
    expect(s.logs.join("\n")).toContain("hook stop: blocked for unpublished");
  });

  it("Stop: pushing and opening a PR clears it; the turn answering a `ready` notification is not gated", async () => {
    const s = await ready();
    commit(s, "a.txt");
    s.t.emit([notify("n1", ["ready"])]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "n1"), "ready notify delivered");
    expect(await runHook(s, "Stop", {})).toBeNull();
    s.t.emit([notify("n2", ["ci_failed"])]);
    await waitFor(() => s.t.of("ack").some((a) => a.id === "n2"), "ci notify delivered");
    expect((await runHook(s, "Stop", {})).decision).toBe("block");
  });

  it("Stop: a pushed branch counts as covered once a subscription names it as its head (the backend's lowercase repo)", async () => {
    const s = await ready();
    commit(s, "a.txt");
    s.remote.sh(dir(s), "push", "-q", "-u", "origin", "dork/abc");
    s.t.setSubscriptions([{ ...fakeView({ repo: "acme/demo", number: 12 }), headRef: "dork/abc" }]);
    expect(await runHook(s, "Stop", {})).toBeNull();
  });

  it("PostToolUse: subscribes to the PR `gh pr create` printed", async () => {
    const s = await ready();
    const out = await runHook(s, "PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/Acme/Demo/pull/12\n", stderr: "" } });
    expect(out).toBeNull();
    expect(s.t.prCalls).toEqual([{ op: "sub", ref: { repo: "Acme/Demo", number: 12 }, source: "auto" }]);
    // the shim and the hook race benignly: the second one finds it listed and does nothing
    await runHook(s, "PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/acme/demo/pull/12\n", stderr: "" } });
    expect(s.t.prCalls).toHaveLength(1);
    await runHook(s, "PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr merge 12 --squash" }, tool_response: { stdout: "", stderr: "✓ Squashed and merged pull request acme/demo#12 (t)\n" } });
    expect(s.t.prCalls.at(-1)).toEqual({ op: "unsub", ref: { repo: "acme/demo", number: 12 } });
    expect(s.t.subscriptions).toEqual([]);
  });

  it("SessionStart: adds the subscribed PRs from the backend's list", async () => {
    const s = await ready();
    s.t.setSubscriptions([{ ...fakeView({ repo: "acme/demo", number: 12 }), title: "Fix login", ci: "failing" }]);
    const out = await runHook(s, "SessionStart", { source: "resume" });
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain('- acme/demo#12 "Fix login": CI failing');
  });

  it("Stop: a work dir with no repositories in it is not an error", async () => {
    const s = await ready();
    rmSync(s.work, { recursive: true, force: true }); // the scan finds no repositories: not an error
    expect(await runHook(s, "Stop", {})).toBeNull();
    expect(JSON.stringify(s.logs)).not.toContain(GH_TOKEN);
  });
});
