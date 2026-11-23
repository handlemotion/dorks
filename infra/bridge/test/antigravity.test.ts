import { chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { createNormalizer } from "../../../apps/server/src/core/normalize";
import { builtCli, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const fake = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));
let cli: string;
beforeAll(() => {
  cli = builtCli();
  chmodSync(fake, 0o755);
});
const cleanup: Bridge[] = [];
afterEach(async () => {
  for (const bridge of cleanup.splice(0)) await bridge.stop(500);
});

const TOKEN = '{"refresh_token":"agy-subscription-secret"}';

async function setup(env: Record<string, string> = {}) {
  const home = tmp("agy-home-");
  const bin = tmp("agy-bin-");
  symlinkSync(fake, join(bin, "agy"));
  const remote = makeRemote();
  const report = join(tmp("agy-report-"), "report.jsonl");
  const host: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    DORK_ID: "agy_dork",
    BRIDGE_PORT: "4749",
    BRIDGE_SECRET: "c".repeat(64),
    DORKS_STATE_DIR: tmp("agy-state-"),
    DORKS_SOCK_DIR: tmp("agy-sock-"),
    DORKS_WORKDIR: tmp("agy-work-"),
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
    provider: "antigravity",
    model: "gemini-4-neon-high",
    env: { FAKE_AGY_REPORT: report, ANTIGRAVITY_OAUTH_TOKEN: Buffer.from(TOKEN).toString("base64"), ...env },
    ghToken: "ghs_unitTestInstallationToken",
    repo: { fullName: "acme/demo", branch: "agent/agy" },
    resumeSessionId: null,
  };
  const logs: string[] = [];
  const bridge = new Bridge({ cfg: loadConfig(host), transport, log: makeLogger("test", redactor, (s) => logs.push(s)), redactor, baseEnv: host, selfCommand: [process.execPath, cli] });
  cleanup.push(bridge);
  await bridge.start();
  transport.emit([{ cid: "cfg1", frame: { t: "fetch_configure" } }]);
  const reports = () =>
    existsSync(report)
      ? readFileSync(report, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  /** The streaming session's starts (not `agy models` or the title's `agy -p`). */
  const sessions = () => reports().filter((r) => r.args?.includes("--input-format"));
  return { bridge, transport, home, reports, sessions, logs };
}

const results = (t: FakeTransport) => t.events().filter((e) => (e.raw as { type?: string }).type === "result");

describe("Antigravity (agy) through its streaming headless mode", () => {
  it("signs in from the shared token, wires MCP and guidance, and streams a turn in the transcript shape", async () => {
    const s = await setup();
    await waitFor(() => s.transport.of("ready")[0], "agy ready");
    await waitFor(() => s.transport.of("agent_models")[0], "agy models");
    expect(s.transport.of("agent_models")[0].models.map((m: { model: string }) => m.model)).toEqual(["gemini-4-neon-high", "gemini-3.8-flash-medium"]);
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "fix tests" } }]);
    await waitFor(() => results(s.transport)[0], "agy turn");
    await s.bridge.outbox.drained();

    const start = s.sessions()[0];
    expect(start.token).toBe(TOKEN); // decoded into the file agy reads without a keyring
    expect(start.envKeys).not.toContain("ANTIGRAVITY_OAUTH_TOKEN");
    expect(start.envKeys).not.toContain("BRIDGE_SECRET");
    expect(start.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gemini-4-neon-high"]));
    expect(start.mcp.mcpServers.dorks.args).toEqual([cli, "dorks", "mcp"]);
    expect(start.rule).toMatch(/^---\ntrigger: always_on\n---/);
    // The first turn of a fresh conversation carries the autonomy briefing, like Claude's SessionStart hook.
    expect(s.reports().find((r) => r.prompt)?.prompt).toMatch(/<system-reminder>[\s\S]*fix tests$/);

    const normalize = createNormalizer();
    const raws = s.transport.events().map((e) => e.raw);
    const bodies = raws.flatMap((raw) => normalize(raw)).flatMap((n) => (n.kind === "event" ? [n.body] : []));
    const types = bodies.map((b) => b.type);
    expect(types).toEqual(expect.arrayContaining(["assistant_delta", "assistant_message", "tool_use", "tool_result", "turn_complete"]));
    // A call agy announced before its parameters shows once, with them (an early empty one used to stick as a blank "Used" row).
    expect(bodies.filter((b) => b.type === "tool_use").map((b) => (b as { summary: string }).summary)).toEqual(["echo hi"]);
    expect(JSON.stringify(raws)).toContain("Done: fix tests");
    expect(s.logs.join(" ")).not.toContain("agy-subscription-secret");
  });

  it("interrupts with SIGINT and goes on in the same conversation", async () => {
    const s = await setup({ FAKE_AGY_WAIT: "1" });
    await waitFor(() => s.transport.of("ready")[0], "ready");
    s.transport.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "long task" } }]);
    await waitFor(() => s.reports().some((r) => r.prompt), "turn started");
    s.transport.emit([{ cid: "i1", frame: { t: "interrupt" } }]);
    await waitFor(() => results(s.transport).some((e) => (e.raw as { result?: string }).result === "interrupted"), "interrupted turn");
    await waitFor(() => s.sessions().length >= 2, "restarted agy");
    expect(s.sessions()[1].args).toEqual(expect.arrayContaining(["--conversation", "conv_fake"]));
    s.transport.emit([{ cid: "m2", frame: { t: "user_message", id: "m2", text: "again" } }]);
    await waitFor(() => results(s.transport).some((e) => !(e.raw as { is_error?: boolean }).is_error), "turn after the interrupt");
    expect(s.transport.of("agent_exited")).toHaveLength(0);
  });
});
