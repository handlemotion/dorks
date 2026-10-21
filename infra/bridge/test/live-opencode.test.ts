// Opt-in: drives the REAL `opencode serve` through the bridge (fake transport, local git remote) against a mock OpenAI-compatible model
// server (fixtures/mock-llm.mjs), so it needs no model key and costs nothing. Skipped unless OPENCODE_BIN points at the binary:
//   npm i --prefix /tmp/oc opencode-ai@1.19.3 && OPENCODE_BIN=/tmp/oc/node_modules/.bin/opencode pnpm --filter @dorks/bridge test live-opencode
// It checks what the fake server (fixtures/fake-opencode.mjs) only imitates: the real event stream, the server password, the dorks MCP
// server as an OpenCode tool, and a session resumed by a second server on the same disk.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, fakeView, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const bin = process.env.OPENCODE_BIN;
const MOCK = fileURLToPath(new URL("./fixtures/mock-llm.mjs", import.meta.url));

describe.skipIf(!bin)("real opencode serve through the bridge", () => {
  let mock: ChildProcess;
  let providerConfig: string;
  const bridges: Bridge[] = [];
  const remote = makeRemote();
  const home = tmp("oc-home-");
  const work = tmp("oc-work-");

  beforeAll(async () => {
    mock = spawn(process.execPath, [MOCK, "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const url = await new Promise<string>((resolve) => mock.stdout!.on("data", (d) => /listening on (\S+)/.test(String(d)) && resolve(/listening on (\S+)/.exec(String(d))![1]!)));
    // A custom provider, the way a user would add one: an OpenCode config file named by OPENCODE_CONFIG (a CLI secret, say).
    providerConfig = join(tmp("oc-cfg-"), "opencode.json");
    writeFileSync(providerConfig, JSON.stringify({
      enabled_providers: ["mock"],
      small_model: "mock/mock-model",
      provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: url, apiKey: "mock-key" }, models: { "mock-model": { name: "Mock", tool_call: true, limit: { context: 100000, output: 4096 } } } } },
    }));
  });
  afterAll(async () => {
    for (const b of bridges) await b.stop(2000);
    mock?.kill();
  });

  async function boot(resume: string | null) {
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, DORK_ID: "live_oc", BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET: "c".repeat(64),
      DORKS_STATE_DIR: tmp("oc-state-"), DORKS_WORKDIR: work, DORKS_GIT_BASE_URL: remote.baseUrl, OPENCODE_BIN: bin,
      DELTA_BATCH_MS: "20", DORKS_BATCH_MS: "5",
    };
    const redactor = new Redactor();
    const logs: string[] = [];
    const t = new FakeTransport();
    t.subscriptions = [fakeView({ repo: "acme/demo", number: 42 })];
    t.configureFrame = {
      t: "configure", env: { OPENCODE_CONFIG: providerConfig }, ghToken: "ghs_live", repo: { fullName: "acme/demo", branch: "dork/live" },
      resumeSessionId: resume, engine: "opencode", model: "mock/mock-model",
    };
    const bridge = new Bridge({ cfg: loadConfig(hostEnv), transport: t, log: makeLogger("live", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, builtCli()] });
    bridges.push(bridge);
    await bridge.start();
    t.emit([{ cid: "cfg", frame: { t: "fetch_configure" } }]);
    return { bridge, t, logs };
  }

  const events = (t: FakeTransport) => t.events().map((e) => (e.raw as { event: Record<string, unknown> & { type: string } }).event);
  const idles = (t: FakeTransport) => events(t).filter((e) => e.type === "idle").length;
  const send = (t: FakeTransport, id: string, text: string) => t.emit([{ cid: id, frame: { t: "user_message", id, text } }]);
  let sessionId = "";

  it("a turn: streamed text, a real bash call on the repo, turn_complete, idle", async () => {
    const { t, logs } = await boot(null);
    send(t, "m1", "show me the readme");
    await waitFor(() => idles(t) === 1, `idle (${logs.join(" | ")})`, 60_000).catch((e) => {
      throw new Error(`${e.message} :: ${JSON.stringify(events(t)).slice(0, 2000)} :: ${JSON.stringify(t.of("agent_exited"))}`);
    });
    const ev = events(t);
    sessionId = ev.find((e) => e.type === "session")!.sessionId as string;
    expect(sessionId).toMatch(/^ses_/);
    expect(ev.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === "text").map((e) => e.text)).toEqual(["Let me read the file.", "Done: the tool answered."]);
    expect(ev.find((e) => e.type === "tool_use")).toMatchObject({ name: "bash", input: { command: "cat README.md" } });
    expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ ok: true, output: expect.stringContaining("# demo") });
    expect(ev.filter((e) => e.type === "turn_complete")).toEqual([{ type: "turn_complete", durationMs: expect.any(Number) }]);
  }, 90_000);

  it("the dorks MCP server is an OpenCode tool: dorks_pr_list answers with the subscriptions", async () => {
    const t = (await boot(sessionId)).t;
    send(t, "m2", "MCP list my PRs");
    await waitFor(() => idles(t) === 1, "idle", 60_000);
    const ev = events(t);
    expect(ev.find((e) => e.type === "session")!.sessionId).toBe(sessionId); // and a second server resumed the first one's session
    expect(ev.find((e) => e.type === "tool_use")).toMatchObject({ name: "dorks_pr_list" });
    expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ ok: true, output: expect.stringContaining("acme/demo#42") });
  }, 90_000);
});
