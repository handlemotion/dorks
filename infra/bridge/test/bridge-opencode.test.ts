import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

// The bridge driving the OpenCode harness against test/fixtures/fake-opencode.mjs (a stand-in for `opencode serve` whose events copy
// the real server's). Engine-independent behaviour (acks, dedupe, numbering, reconnects) is covered with the fake Claude CLI in bridge.test.ts.

const FAKE_OPENCODE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const BRIDGE_SECRET = "b".repeat(64);
const PROVIDER_KEY = "sk-ant-api03-UNIT-TEST-KEY";
let cli: string;
beforeAll(() => {
  cli = builtCli();
  chmodSync(FAKE_OPENCODE, 0o755);
});

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

type Report = { argv: string[]; envKeys: string[]; config: any; prompts: { sessionID: string; parts: { text: string }[]; system?: string; model?: unknown }[]; aborts: number; permissionReplies: { reply: string; message?: string }[]; overlaps: number };

async function setup(opts: { resume?: string | null; model?: string; env?: Record<string, string>; home?: string } = {}) {
  const remote = makeRemote();
  const work = tmp("work-");
  const report = join(tmp("report-"), "opencode.json");
  const logs: string[] = [];
  const home = opts.home ?? tmp("home-");
  const hostEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    DORK_ID: "dork_oc_1",
    BRIDGE_URL: "https://example.convex.cloud",
    BRIDGE_SECRET,
    DORKS_STATE_DIR: tmp("state-"),
    DORKS_WORKDIR: work,
    DORKS_GIT_BASE_URL: remote.baseUrl,
    OPENCODE_BIN: FAKE_OPENCODE,
    DELTA_BATCH_MS: "20",
    DORKS_BATCH_MS: "5",
    HEARTBEAT_MS: "60000",
  };
  const redactor = new Redactor();
  redactor.add(BRIDGE_SECRET);
  const t = new FakeTransport();
  t.configureFrame = {
    t: "configure",
    env: { ANTHROPIC_API_KEY: PROVIDER_KEY, FAKE_OPENCODE_REPORT: report, ...(opts.env ?? {}) },
    ghToken: "ghs_unitTestInstallationToken",
    repo: { fullName: "acme/demo", branch: "dork/abc" },
    resumeSessionId: opts.resume ?? null,
    engine: "opencode",
    ...(opts.model ? { model: opts.model } : {}),
  };
  const bridge = new Bridge({ cfg: loadConfig(hostEnv), transport: t, log: makeLogger("t", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, cli] });
  cleanup.push(() => bridge.stop(500));
  const read = (): Report | false => existsSync(report) && (() => { try { return JSON.parse(readFileSync(report, "utf8")); } catch { return false; } })();
  return { bridge, t, logs, work, home, remote, read };
}

const configure = (t: FakeTransport, cid = "cfg1") => t.emit([{ cid, frame: { t: "fetch_configure" } }]);
const msg = (id: string, text: string) => ({ cid: id, frame: { t: "user_message" as const, id, text } });
/** The neutral agent events pushed so far. */
const agentEvents = (t: FakeTransport) => t.events().map((e) => (e.raw as { type: string; event: { type: string } & Record<string, unknown> }).event);
const kinds = (t: FakeTransport) => agentEvents(t).map((e) => e.type);
const turns = (t: FakeTransport) => kinds(t).filter((k) => k === "idle").length;

describe("bridge with a fake opencode server", () => {
  it("configure: starts `opencode serve` in the repo with a locked server and unattended config, opens a session, ready", async () => {
    const { bridge, t, work, read } = await setup({ model: "anthropic/claude-sonnet-4-5" });
    await bridge.start();
    configure(t);
    await waitFor(() => t.of("ready").length, "ready");
    const r = await waitFor(read, "report");
    expect(r.argv).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(r.envKeys).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG_CONTENT", "DORKS_SOCK"]));
    expect(r.envKeys).not.toContain("BRIDGE_SECRET");
    expect(r.envKeys).not.toContain("OPENCODE_BIN");
    expect(r.config).toMatchObject({ autoupdate: false, model: "anthropic/claude-sonnet-4-5", permission: { bash: "allow", edit: "allow" }, mcp: { dorks: { type: "local", command: [process.execPath, cli, "dorks", "mcp"] } } });
    await waitFor(() => kinds(t).includes("session"), "session event");
    expect(agentEvents(t)[0]).toEqual({ type: "session", sessionId: expect.stringMatching(/^ses_/) });
    expect(existsSync(join(work, "acme/demo/.git"))).toBe(true);
  });

  it("a turn: neutral text deltas, final texts, tool use + result, turn_complete, idle; acked once; the model and system context go with the prompt", async () => {
    const { bridge, t, read } = await setup({ model: "anthropic/claude-sonnet-4-5" });
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "hello")]);
    await waitFor(() => turns(t) === 1, "turn done");
    expect(kinds(t).filter((k) => k !== "text_delta")).toEqual(["session", "tool_use", "text", "tool_result", "text", "turn_complete", "idle"]);
    const texts = agentEvents(t).filter((e) => e.type === "text").map((e) => e.text);
    expect(texts).toEqual(["w0 w1 w2 ", "done."]);
    expect(agentEvents(t).find((e) => e.type === "tool_use")).toMatchObject({ name: "bash", input: { command: "echo hi" } });
    expect(agentEvents(t).find((e) => e.type === "tool_result")).toMatchObject({ ok: true, output: "hi\n" });
    expect(t.of("ack").filter((a) => a.id === "m1")).toHaveLength(1);
    const p = (await waitFor(read, "report")).prompts[0]!;
    expect(p.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(p.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    expect(p.system).toContain("dorks pr sub"); // the SessionStart context, as the prompt's system text
    expect(JSON.stringify(t.events())).not.toContain(PROVIDER_KEY);
  });

  it("messages sent mid-turn run one turn at a time, in order (never two prompts at once)", async () => {
    const { bridge, t, read } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "one"), msg("m2", "two"), msg("m3", "three")]);
    await waitFor(() => turns(t) === 1 && kinds(t).filter((k) => k === "turn_complete").length === 3, "three turns, one idle", 15_000);
    const r = await waitFor(read, "report");
    expect(r.prompts.map((p) => p.parts[0]!.text)).toEqual(["one", "two", "three"]);
    expect(r.overlaps).toBe(0);
  });

  it("interrupt: aborts the turn, which completes without an error; a message queued behind it still runs", async () => {
    const { bridge, t, read } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "SLOW please")]);
    await waitFor(() => kinds(t).filter((k) => k === "text_delta").length >= 2, "streaming");
    t.emit([msg("m1", "SLOW please"), msg("m2", "after")]);
    t.emit([{ cid: "i1", frame: { t: "interrupt" } }]);
    await waitFor(() => turns(t) === 1, "idle after both", 15_000);
    const r = await waitFor(read, "report");
    expect(r.aborts).toBe(1);
    expect(r.prompts.map((p) => p.parts[0]!.text)).toEqual(["SLOW please", "after"]);
    expect(agentEvents(t).filter((e) => e.type === "turn_complete").every((e) => e.error === undefined)).toBe(true);
    expect(t.of("ack").map((a) => a.id)).toContain("i1");
  });

  it("a provider error completes the turn with the error", async () => {
    const { bridge, t } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "BADKEY")]);
    await waitFor(() => turns(t) === 1, "idle");
    expect(agentEvents(t).filter((e) => e.type === "turn_complete")).toEqual([{ type: "turn_complete", durationMs: expect.any(Number), error: "APIError: invalid x-api-key" }]);
  });

  it("a permission request is rejected with a message (nobody can approve), and the turn carries on", async () => {
    const { bridge, t, read } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "PERMISSION")]);
    await waitFor(() => turns(t) === 1, "idle");
    expect((await waitFor(read, "report")).permissionReplies).toEqual([{ id: expect.stringMatching(/^per_/), reply: "reject", message: expect.stringContaining("unattended") }]);
    expect(agentEvents(t).find((e) => e.type === "tool_result")).toMatchObject({ ok: false });
  });

  it("PostToolUse parity: a `gh pr create` the agent ran subscribes to the PR it printed", async () => {
    const { bridge, t } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "PRCREATE")]);
    await waitFor(() => t.prCalls.length, "subscribe");
    expect(t.prCalls).toEqual([{ op: "sub", ref: { repo: "acme/demo", number: 7 }, source: "auto" }]);
  });

  it("Stop gate parity: unpushed work blocks the end of the turn once, as the next prompt; then the dork goes idle", async () => {
    const { bridge, t, read, work, remote } = await setup();
    await bridge.start();
    configure(t);
    await waitFor(() => t.of("ready").length, "ready");
    const repo = join(work, "acme/demo");
    writeFileSync(join(repo, "x.txt"), "x\n");
    remote.sh(repo, "add", ".");
    remote.sh(repo, "commit", "-m", "local work");
    t.emit([msg("m1", "do it")]);
    await waitFor(() => turns(t) === 1, "idle", 15_000);
    const r = await waitFor(read, "report");
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1]!.parts[0]!.text).toMatch(/push|pull request/i);
    expect(kinds(t).filter((k) => k === "turn_complete")).toHaveLength(2);
    // a second turn with the same condition still standing is not gated again
    t.emit([msg("m2", "again")]);
    await waitFor(() => turns(t) === 2, "second idle", 15_000);
    expect((await waitFor(read, "report")).prompts).toHaveLength(3);
  });

  it("resume: the session survives a restart (same home), and a session the server does not know starts fresh and still answers", async () => {
    const first = await setup();
    await first.bridge.start();
    configure(first.t);
    first.t.emit([msg("m1", "hello")]);
    await waitFor(() => turns(first.t) === 1, "turn");
    const sid = agentEvents(first.t)[0]!.sessionId as string;
    await first.bridge.stop(500);

    const again = await setup({ resume: sid, home: first.home });
    await again.bridge.start();
    configure(again.t);
    again.t.emit([msg("m2", "back")]);
    await waitFor(() => turns(again.t) === 1, "resumed turn");
    expect(agentEvents(again.t)[0]).toEqual({ type: "session", sessionId: sid });

    const lost = await setup({ resume: "ses_gone", home: first.home });
    await lost.bridge.start();
    configure(lost.t);
    lost.t.emit([msg("m3", "anyone?")]);
    await waitFor(() => turns(lost.t) === 1, "fresh turn");
    const sessions = agentEvents(lost.t).filter((e) => e.type === "session").map((e) => e.sessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toBe("ses_gone");
    expect(lost.t.of("agent_exited")).toEqual([]);
    expect(lost.logs.join("\n")).toMatch(/starting a fresh session/);
  });

  it("no database on the box: a remembered session id is not even tried", async () => {
    const { bridge, t, logs } = await setup({ resume: "ses_old" });
    await bridge.start();
    configure(t);
    await waitFor(() => kinds(t).includes("session"), "session");
    expect(logs.join("\n")).toMatch(/not found on this box/);
  });

  it("flush: waits for the turn, persists the session database, acks and says flushed", async () => {
    const { bridge, t, home } = await setup();
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "hello")]);
    t.emit([msg("m1", "hello"), { cid: "f1", frame: { t: "flush" } }]);
    await waitFor(() => t.of("flushed").length, "flushed", 15_000);
    expect(turns(t)).toBe(1);
    expect(existsSync(join(home, ".local/share/opencode/opencode.db"))).toBe(true);
  });

  it("a server that dies is reported as agent_exited with its code", async () => {
    const { bridge, t } = await setup({ env: { FAKE_OPENCODE_CRASH: "1" } });
    await bridge.start();
    configure(t);
    await waitFor(() => t.of("agent_exited").length, "agent_exited");
    expect(t.of("agent_exited")[0]!.code).toBe(3);
  });

  it("a Claude dork on the same bridge build is untouched: no engine means Claude Code", async () => {
    const { bridge, t } = await setup();
    t.configureFrame = { ...t.configureFrame!, engine: undefined, env: { ...t.configureFrame!.env } };
    const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
    (bridge as unknown as { cfg: { claudeBin: string } }).cfg.claudeBin = fakeClaude;
    await bridge.start();
    configure(t);
    t.emit([msg("m1", "hi")]);
    await waitFor(() => t.events().some((e) => (e.raw as { type?: string }).type === "result"), "claude result");
    expect(t.events().every((e) => (e.raw as { type?: string }).type !== "dorks_agent")).toBe(true);
  });
});
