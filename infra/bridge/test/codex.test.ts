import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { createNormalizer } from "@dorks/core/normalize";
import { builtCli, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const fake = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
let cli: string;
beforeAll(() => {
  cli = builtCli();
});
const cleanup: Bridge[] = [];
afterEach(async () => {
  for (const bridge of cleanup.splice(0)) await bridge.stop(500);
});

async function setup(
  home = tmp("codex-home-"),
  state = tmp("codex-state-"),
  resumeSessionId: string | null = null,
  extraEnv: Record<string, string> = {},
  codexModel?: { model: string; effort: string },
  boatConnected = true,
  nameFrom?: string,
  frame: Record<string, unknown> = {},
) {
  // Boat installs the account's ChatGPT sign-in in each sandbox's ~/.codex; the fake reads auth.json for "connected".
  if (boatConnected) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
  }
  const bin = tmp("codex-bin-");
  symlinkSync(fake, join(bin, "codex"));
  const remote = makeRemote();
  const report = join(tmp("codex-report-"), "report.json");
  const host: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    DORK_ID: "codex_dork",
    BRIDGE_PORT: "4748",
    BRIDGE_SECRET: "b".repeat(64),
    DORKS_STATE_DIR: state,
    DORKS_SOCK_DIR: state,
    DORKS_WORKDIR: tmp("codex-work-"),
    DORKS_GIT_BASE_URL: remote.baseUrl,
    DORKS_BATCH_MS: "5",
    DELTA_BATCH_MS: "10",
    HEARTBEAT_MS: "60000",
  };
  const redactor = new Redactor();
  redactor.add(host.BRIDGE_SECRET);
  const transport = new FakeTransport();
  transport.configureFrame = {
    t: "configure",
    provider: "codex",
    codexModel,
    env: { FAKE_CODEX_REPORT: report, OPENAI_API_KEY: "should-not-be-billed", CF_TOKEN: "cli-secret-only", ...extraEnv },
    ghToken: "ghs_unitTestInstallationToken",
    repo: { fullName: "acme/demo", branch: "agent/codex" },
    resumeSessionId,
    nameFrom,
    ...frame,
  } as typeof transport.configureFrame;
  const logs: string[] = [];
  const bridge = new Bridge({ cfg: loadConfig(host), transport, log: makeLogger("test", redactor, (s) => logs.push(s)), redactor, baseEnv: host, selfCommand: [process.execPath, cli] });
  cleanup.push(bridge);
  await bridge.start();
  transport.emit([{ cid: "cfg1", frame: { t: "fetch_configure" } }]);
  return { bridge, transport, home, state, report, logs };
}

/** What the bridge sent the fake app-server, in order (fixtures/fake-codex.mjs `note`). */
const sent = (report: string): { method: string; [k: string]: unknown }[] =>
  existsSync(`${report}.log`)
    ? readFileSync(`${report}.log`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const inputText = (entry: Record<string, unknown>) => ((entry.input ?? []) as { type: string; text?: string }[]).map((i) => i.text ?? "").join(" ");

describe("Codex through a Boat ChatGPT connection", () => {
  it("streams a GPT-6 Sol turn without API-key billing", async () => {
    const s = await setup();
    await waitFor(() => s.transport.of("ready")[0], "Codex ready");
    const report = JSON.parse(readFileSync(s.report, "utf8"));
    expect(report.envKeys).not.toContain("OPENAI_API_KEY");
    expect(report.envKeys).not.toContain("BRIDGE_SECRET");
    expect(report.args).toEqual(expect.arrayContaining(["app-server", "--listen", "stdio://"]));
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix tests" } }]);
    await waitFor(() => s.transport.events().some((e) => (e.raw as { type?: string }).type === "result"), "Codex turn");
    await s.bridge.outbox.drained();
    expect(s.transport.of("ack").some((f) => f.id === "m1")).toBe(true);
    const raws = s.transport.events().map((e) => e.raw);
    expect(JSON.stringify(raws)).toContain("Done: fix tests");
    expect(JSON.parse(readFileSync(s.report, "utf8"))).toMatchObject({
      model: "gpt-6-sol",
      effort: "high",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
    });
    const normalize = createNormalizer();
    const eventTypes = raws
      .flatMap((raw) => normalize(raw))
      .filter((n) => n.kind === "event")
      .map((n) => n.body.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["assistant_delta", "assistant_message", "tool_use", "tool_result", "turn_complete"]));
    expect(s.logs.join(" ")).not.toContain("should-not-be-billed");
  });

  it("names the dork on a side thread with the lightest model, outside the transcript", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_LUNA: "1" }, undefined, true, "the login tests flake on CI, fix them");
    await waitFor(() => s.transport.of("title")[0], "title");
    expect(s.transport.of("title")[0].text).toBe("Fix the flaky login tests");
    expect(JSON.parse(readFileSync(`${s.report}.side`, "utf8"))).toEqual({ model: "gpt-6-luna", effort: "low", sandboxPolicy: { type: "readOnly" } });
    expect(JSON.stringify(s.transport.events())).not.toContain("flaky");
  });

  it("resumes a saved Codex thread after the bridge restarts", async () => {
    const first = await setup();
    await waitFor(() => first.transport.of("ready")[0], "first ready");
    await first.bridge.stop(500);
    const next = await setup(first.home, first.state, "thr_fake");
    await waitFor(() => next.transport.of("ready")[0], "resumed ready");
    const init = next.transport.events().find((e) => (e.raw as { subtype?: string }).subtype === "init");
    expect(init?.raw).toMatchObject({ session_id: "thr_fake" });
  });

  it("without Dorks' sign-in or a Boat connection, reports how to sign in and exits", async () => {
    const s = await setup(undefined, undefined, null, {}, undefined, false);
    await waitFor(() => s.transport.of("codex_issue")[0], "Boat account issue");
    await waitFor(() => s.transport.of("agent_exited")[0], "Boat account exit");
    expect(s.transport.of("ready")).toHaveLength(0);
    expect(s.transport.of("codex_issue")[0].message).toContain("Boat Agents & Proxying");
  });

  it("does not claim readiness if the account cannot use GPT-6 Sol at high effort", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_MODEL_MISSING: "1" });
    await waitFor(() => s.transport.of("codex_issue")[0], "unavailable model");
    await waitFor(() => s.transport.of("agent_exited")[0], "exit after missing model");
    expect(s.transport.of("ready")).toHaveLength(0);
    expect(s.transport.of("codex_models")[0].models).toEqual([{ model: "gpt-6.1-sol", efforts: ["medium", "high"] }]);
    expect(s.transport.of("codex_issue")[0].message).toContain("No other model or billing method was selected");
    const next = await setup(s.home, s.state, null, { FAKE_CODEX_MODEL_MISSING: "1" }, { model: "gpt-6.1-sol", effort: "high" });
    await waitFor(() => next.transport.of("ready")[0], "chosen model ready");
    next.transport.emit([{ cid: "m2", frame: { t: "user_message", id: "m2", text: "try again" } }]);
    await waitFor(() => next.transport.events().some((e) => (e.raw as { type?: string }).type === "result"), "turn with chosen model");
    expect(JSON.parse(readFileSync(next.report, "utf8"))).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });

  it("interrupts the running turn without stopping the app-server", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_WAIT: "1" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "long task" } }]);
    await waitFor(() => s.transport.of("ack").some((f) => f.id === "m1"), "message accepted");
    s.transport.emit([{ cid: "i1", frame: { t: "interrupt" } }]);
    await waitFor(() => s.transport.of("ack").some((f) => f.id === "i1"), "interrupt ack");
    await waitFor(() => s.transport.events().some((e) => (e.raw as { type?: string; result?: string }).result === "interrupted"), "interrupted turn");
    expect(s.transport.of("agent_exited")).toHaveLength(0);
  });

  it("starts a new thread if the old box's session was lost", async () => {
    const s = await setup(undefined, undefined, "thr_old");
    await waitFor(() => s.transport.of("ready")[0], "fresh thread");
    expect(s.transport.events().find((e) => (e.raw as { subtype?: string }).subtype === "init")?.raw).toMatchObject({ session_id: "thr_fake" });
  });

  it("shows a plan limit error without falling back to another payer", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_TURN_FAILED: "1" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "do work" } }]);
    await waitFor(() => s.transport.events().some((e) => (e.raw as { result?: string }).result === "ChatGPT plan limit reached"), "plan limit");
    const normalize = createNormalizer();
    expect(
      s.transport
        .events()
        .flatMap((e) => normalize(e.raw))
        .some((n) => n.kind === "event" && n.body.type === "error"),
    ).toBe(true);
    expect(s.transport.of("agent_exited")).toHaveLength(0);
    expect(JSON.parse(readFileSync(s.report, "utf8")).envKeys).not.toContain("OPENAI_API_KEY");
  });

  it("steers a running turn with a message sent mid-turn instead of queueing it behind the turn", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_SLOW: "400" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix the bug" } }]);
    await waitFor(() => sent(s.report).some((e) => e.method === "turn/start"), "first turn");
    s.transport.emit([{ cid: "m2", frame: { t: "user_message", id: "m2", text: "use the new API" } }]);
    await waitFor(() => s.transport.of("ack").some((f) => f.id === "m2"), "steer acked");
    await waitFor(() => JSON.stringify(s.transport.events()).includes("(steered: use the new API)"), "steered answer");
    expect(sent(s.report).filter((e) => e.method === "turn/start")).toHaveLength(1);
    expect(sent(s.report).filter((e) => e.method === "turn/steer")).toHaveLength(1);
  });

  it("starts the thread with the standing instructions, the owner's MCP servers and skills, and briefs its first turn", async () => {
    const home = tmp("codex-home-");
    mkdirSync(join(home, ".claude", "skills", "release-notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: notes\n---\n");
    const mcpServers = [
      { name: "docs", transport: "http", url: "https://mcp.example.com/mcp?key=k-123", headers: { Authorization: "Bearer t-456" } },
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "k-789" } },
    ];
    const s = await setup(home, undefined, null, {}, undefined, true, undefined, { mcpServers, role: "worker" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    const start = sent(s.report).find((e) => e.method === "thread/start")!;
    expect(start.developerInstructions).toContain("final answer");
    expect(start.config).toMatchObject({
      "mcp_servers.docs": { url: "https://mcp.example.com/mcp?key=k-123", env_http_headers: { Authorization: expect.stringMatching(/^DORKS_MCP_0_H0$/) } },
      "mcp_servers.local": { command: "node", args: ["server.js"], env: { API_KEY: "k-789" } },
    });
    await waitFor(() => s.transport.of("agent_commands")[0], "skills as commands");
    expect(s.transport.of("agent_commands")[0].commands).toEqual([{ name: "release-notes", description: "skill release-notes" }]);
    expect(s.transport.of("agent_models")[0]).toMatchObject({ models: [{ model: "gpt-6-sol", name: "GPT-6 Sol", efforts: ["medium", "high"] }], effort: "high" });
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "/release-notes for v2" } }]);
    await waitFor(() => sent(s.report).some((e) => e.method === "turn/start"), "turn");
    const turn = sent(s.report).find((e) => e.method === "turn/start")!;
    expect(turn.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "skill", name: "release-notes" })]));
    expect(inputText(turn)).toContain("How autonomy works here");
    expect(inputText(turn)).toContain("for v2");
  });

  it("invokes a skill named later in the first message, sent before the skills were listed", async () => {
    const home = tmp("codex-home-");
    mkdirSync(join(home, ".claude", "skills", "writing"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "writing", "SKILL.md"), "---\nname: writing\ndescription: prose\n---\n");
    const s = await setup(home, undefined, null, {}, undefined, true);
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "remove this and use the /writing skill to improve the copy" } }]);
    await waitFor(() => sent(s.report).some((e) => e.method === "turn/start"), "turn");
    const turn = sent(s.report).find((e) => e.method === "turn/start")!;
    expect(turn.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "skill", name: "writing" })]));
    expect(inputText(turn)).toContain("use the /writing skill to improve the copy");
  });

  it("shows edits and the plan as Claude's tools, declines approvals, and sends an untested change back once", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_EDIT: "1", FAKE_CODEX_VERDICT: "needs_live_test" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix the bug" } }]);
    await waitFor(() => sent(s.report).filter((e) => e.method === "turn/start").length === 2, "the gate's continuation");
    await waitFor(() => s.transport.events().filter((e) => (e.raw as { type?: string }).type === "result").length === 2, "both turns end");
    const [, again] = sent(s.report).filter((e) => e.method === "turn/start");
    expect(inputText(again!)).toContain("Before you stop: test this change against the real running software");
    expect(inputText(again!)).toContain("curl /health");
    // The continuation is not judged again (Claude Code's stop_hook_active): one judge, two turns.
    expect(sent(s.report).filter((e) => e.method === "side" && e.judging)).toHaveLength(1);
    expect(sent(s.report).find((e) => e.method === "approval")).toEqual({ method: "approval", decision: "decline" });
    const normalize = createNormalizer();
    const tools = s.transport
      .events()
      .flatMap((e) => normalize(e.raw))
      .flatMap((n) => (n.kind === "event" && n.body.type === "tool_use" ? [n.body] : []));
    expect(tools.find((b) => b.name === "Edit")?.input).toEqual({ file_path: "src/app.ts", old_string: "old", new_string: "new" });
    expect(tools.find((b) => b.name === "TodoWrite")?.input).toMatchObject({
      todos: [
        { content: "Fix the bug", status: "in_progress" },
        { content: "Test it", status: "pending" },
      ],
    });
  });

  it("signs Codex in with Dorks' own ChatGPT access token, and answers its refresh through the server", async () => {
    const codexAuth = { accessToken: "first-access-token", accountId: "acct_test", planType: "plus" };
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_REFRESH: "1" }, undefined, false, undefined, { codexAuth });
    await waitFor(() => s.transport.of("ready")[0], "ready on Dorks' sign-in, with no Boat sign-in in the box");
    expect(sent(s.report).find((e) => e.method === "login")).toEqual({ method: "login", accessToken: "first-access-token", accountId: "acct_test" });
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix tests" } }]);
    await waitFor(() => s.transport.events().some((e) => (e.raw as { type?: string }).type === "result"), "turn after the refresh");
    expect(sent(s.report).find((e) => e.method === "refreshed")).toEqual({ method: "refreshed", accessToken: "fresh-access-1", error: null });
    // The tokens never reach the transcript or the log.
    expect(JSON.stringify(s.transport.events())).not.toMatch(/first-access-token|fresh-access-1/);
    expect(s.logs.join(" ")).not.toMatch(/first-access-token|fresh-access-1/);
  });
});
