import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  extraEnv: Record<string, string> = {}, codexModel?: { model: string; effort: string }, codexAuthSource?: "boat" | "device") {
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
    t: "configure", provider: "codex", codexModel, codexAuthSource,
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

describe("Codex on a personal sandbox", () => {
  it("shows a device code, waits for sign-in, then streams a GPT-6 Sol turn without API-key billing", async () => {
    const s = await setup();
    const login = await waitFor(() => s.transport.of("codex_login")[0], "device code");
    expect(login).toMatchObject({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
    expect(s.transport.of("ready")).toHaveLength(0);
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
    expect(JSON.stringify(raws)).toContain("commandExecution");
    expect(JSON.parse(readFileSync(s.report, "utf8"))).toMatchObject({
      model: "gpt-6-sol", effort: "high", sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
    });
    const normalize = createNormalizer();
    const eventTypes = raws.flatMap((raw) => normalize(raw)).filter((n) => n.kind === "event").map((n) => n.body.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["assistant_delta", "assistant_message", "tool_use", "tool_result", "turn_complete"]));
    expect(existsSync(join(s.home, ".codex", "auth.json"))).toBe(true);
    expect(s.logs.join(" ")).not.toContain("should-not-be-billed");
  });

  it("resumes a saved Codex thread after the bridge restarts without another code", async () => {
    const first = await setup();
    await waitFor(() => first.transport.of("ready")[0], "first ready");
    await first.bridge.stop(500);
    const next = await setup(first.home, first.state, "thr_fake");
    await waitFor(() => next.transport.of("ready")[0], "resumed ready");
    expect(next.transport.of("codex_login")).toHaveLength(0);
    const init = next.transport.events().find((e) => (e.raw as { subtype?: string }).subtype === "init");
    expect(init?.raw).toMatchObject({ session_id: "thr_fake" });
  });

  it("uses an account-wide Boat ChatGPT connection without asking for another code", async () => {
    const home = tmp("codex-boat-home-");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    const s = await setup(home, undefined, null, {}, undefined, "boat");
    await waitFor(() => s.transport.of("ready")[0], "Boat ChatGPT ready");
    expect(s.transport.of("codex_login")).toHaveLength(0);
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix this" } }]);
    await waitFor(() => s.transport.events().some((e) => (e.raw as { type?: string }).type === "result"), "Boat turn");
    expect(JSON.parse(readFileSync(s.report, "utf8")).envKeys).not.toContain("OPENAI_API_KEY");
  });

  it("does not fall back to a per-box login if the Boat account connection is missing", async () => {
    const s = await setup(undefined, undefined, null, {}, undefined, "boat");
    await waitFor(() => s.transport.of("codex_issue")[0], "Boat account issue");
    await waitFor(() => s.transport.of("agent_exited")[0], "Boat account exit");
    expect(s.transport.of("codex_login")).toHaveLength(0);
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
    expect(next.transport.of("codex_login")).toHaveLength(0);
    next.transport.emit([{ cid: "m2", frame: { t: "user_message", id: "m2", text: "try again" } }]);
    await waitFor(() => next.transport.events().some((e) => (e.raw as { type?: string }).type === "result"), "turn with chosen model");
    expect(JSON.parse(readFileSync(next.report, "utf8"))).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });

  it("reports an unsuccessful device-code sign-in and does not run turns", async () => {
    const s = await setup(undefined, undefined, null, { FAKE_CODEX_LOGIN_FAIL: "1" });
    await waitFor(() => s.transport.of("codex_login")[0], "device code");
    await waitFor(() => s.transport.of("codex_issue")[0], "login failure");
    expect(s.transport.of("ready")).toHaveLength(0);
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

  it("signs out on request, shows a fresh code, and resumes the same thread", async () => {
    const s = await setup();
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "reconnect1", frame: { t: "codex_reconnect" } }]);
    await waitFor(() => s.transport.of("codex_login").length === 2, "new device code");
    expect(s.transport.of("ready")).toHaveLength(1);
    await waitFor(() => s.transport.of("ready").length === 2, "ready after reconnect");
    expect(s.transport.of("ack").some((f) => f.id === "reconnect1")).toBe(true);
    expect(s.transport.events().filter((e) => (e.raw as { subtype?: string }).subtype === "init")).toHaveLength(2);
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
