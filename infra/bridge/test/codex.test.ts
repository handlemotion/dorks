import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { createNormalizer } from "../../../apps/server/src/core/normalize";
import { builtCli, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const fake = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
let cli: string;
beforeAll(() => { cli = builtCli(); });
const cleanup: Bridge[] = [];
afterEach(async () => { for (const bridge of cleanup.splice(0)) await bridge.stop(500); });

async function setup(home = tmp("codex-home-"), state = tmp("codex-state-"), resumeSessionId: string | null = null,
  extraEnv: Record<string, string> = {}, codexModel?: { model: string; effort: string }, boatConnected = true) {
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
    PATH: `${bin}:${process.env.PATH}`, HOME: home, DORK_ID: "codex_dork",
    BRIDGE_URL: "https://bridge.example.test", BRIDGE_SECRET: "b".repeat(64),
    DORKS_STATE_DIR: state, DORKS_WORKDIR: tmp("codex-work-"), DORKS_GIT_BASE_URL: remote.baseUrl,
    DORKS_BATCH_MS: "5", DELTA_BATCH_MS: "10", HEARTBEAT_MS: "60000",
  };
  const redactor = new Redactor();
  redactor.add(host.BRIDGE_SECRET);
  const transport = new FakeTransport();
  transport.configureFrame = {
    t: "configure", provider: "codex", codexModel,
    env: { FAKE_CODEX_REPORT: report, OPENAI_API_KEY: "should-not-be-billed", CF_TOKEN: "cli-secret-only", ...extraEnv },
    ghToken: "ghs_unitTestInstallationToken", repo: { fullName: "acme/demo", branch: "agent/codex" }, resumeSessionId,
  };
  const logs: string[] = [];
  const bridge = new Bridge({ cfg: loadConfig(host), transport, log: makeLogger("test", redactor, (s) => logs.push(s)), redactor, baseEnv: host, selfCommand: [process.execPath, cli] });
  cleanup.push(bridge);
  await bridge.start();
  transport.emit([{ cid: "cfg1", frame: { t: "fetch_configure" } }]);
  return { bridge, transport, home, state, report, logs };
}

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
      model: "gpt-6-sol", effort: "high", sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
    });
    const normalize = createNormalizer();
    const eventTypes = raws.flatMap((raw) => normalize(raw)).filter((n) => n.kind === "event").map((n) => n.body.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["assistant_delta", "assistant_message", "tool_use", "tool_result", "turn_complete"]));
    expect(s.logs.join(" ")).not.toContain("should-not-be-billed");
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

  it("never signs in per box: a missing Boat connection reports an issue and exits", async () => {
    const s = await setup(undefined, undefined, null, {}, undefined, false);
    await waitFor(() => s.transport.of("codex_issue")[0], "Boat account issue");
    await waitFor(() => s.transport.of("agent_exited")[0], "Boat account exit");
    expect(s.transport.of("ready")).toHaveLength(0);
    expect(s.transport.of("codex_issue")[0].message).toContain("Boat account");
  });

  it("does not claim readiness if the account cannot use GPT-6 Sol at high effort", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_MODEL_MISSING: "1" });
    await waitFor(() => s.transport.of("codex_issue")[0], "unavailable model");
    await waitFor(() => s.transport.of("agent_exited")[0], "exit after missing model");
    expect(s.transport.of("ready")).toHaveLength(0);
    expect(s.transport.of("codex_models")[0].models).toEqual([{ model: "gpt-6.1-sol", efforts: ["high"] }]);
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
    expect(s.transport.events().flatMap((e) => normalize(e.raw)).some((n) => n.kind === "event" && n.body.type === "error")).toBe(true);
    expect(s.transport.of("agent_exited")).toHaveLength(0);
    expect(JSON.parse(readFileSync(s.report, "utf8")).envKeys).not.toContain("OPENAI_API_KEY");
  });
});
