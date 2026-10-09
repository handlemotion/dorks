// Opt-in: drives the REAL `claude` CLI through the bridge (fake transport, local git remote). Skipped unless a credential is present.
//   CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) pnpm --filter @dorks/bridge test live      (or ANTHROPIC_API_KEY=…)
// Costs a few cents: three short turns. CLAUDE_BIN overrides the binary; LIVE_CLAUDE_ARGS adds flags (e.g. "--model haiku").
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!token && !apiKey)("real claude CLI through the bridge", () => {
  const bridges: Bridge[] = [];
  afterAll(async () => {
    for (const b of bridges) await b.stop(1000);
  });

  async function boot(state: string, work: string, remoteBase: string, resume: string | null, home: string) {
    // A clean HOME: the CLI must authenticate from the configured env alone, like in a fresh box. A paused box keeps its disk, so a
    // second boot of the same box reuses the same HOME (the session transcript lives there).
    mkdirSync(home, { recursive: true });
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, DORK_ID: "live_1", BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET: "c".repeat(64),
      DORKS_STATE_DIR: state, DORKS_WORKDIR: work, DORKS_GIT_BASE_URL: remoteBase, DORKS_CLAUDE_ARGS: process.env.LIVE_CLAUDE_ARGS ?? "",
      ...(process.env.CLAUDE_BIN ? { CLAUDE_BIN: process.env.CLAUDE_BIN } : {}),
    };
    const t = new FakeTransport();
    t.configureFrame = {
      t: "configure", ghToken: "ghs_live_unused", repo: { fullName: "acme/demo", branch: "dork/live" }, resumeSessionId: resume,
      env: { ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
    };
    const redactor = new Redactor();
    const b = new Bridge({ cfg: loadConfig(hostEnv), transport: t, log: makeLogger("live", redactor, () => {}), redactor, baseEnv: hostEnv });
    bridges.push(b);
    await b.start();
    t.emit([{ cid: "cfg", frame: { t: "fetch_configure" } }]);
    await waitFor(() => t.of("ready").length, "ready");
    return { b, t };
  }
  const turn = async (t: FakeTransport, id: string, text: string, idleCount: number) => {
    t.emit([{ cid: id, frame: { t: "user_message", id, text } }]);
    await waitFor(() => t.events().filter((e) => (e.raw as any).state === "idle").length >= idleCount, `turn ${id} idle`, 120_000);
  };
  const assistantText = (t: FakeTransport) => t.events().filter((e) => (e.raw as any).type === "assistant").map((e) => JSON.stringify((e.raw as any).message.content)).join("\n");

  it("streams a turn, uses a tool, and resumes the same session in a new bridge process", async () => {
    const remote = makeRemote();
    const state = tmp("live-state-");
    const work = tmp("live-work-");
    const home = tmp("live-home-");
    const one = await boot(state, work, remote.baseUrl, null, home);

    await turn(one.t, "m1", "Reply with exactly the word PONG and nothing else.", 1);
    const types1 = one.t.events().map((e) => (e.raw as any).type);
    expect(types1).toContain("stream_event"); // partial messages are on
    expect(JSON.stringify(one.t.events().map((e) => e.raw))).toContain("text_delta");
    expect(assistantText(one.t)).toContain("PONG");
    const init = one.t.events().find((e) => (e.raw as any).subtype === "init")!;
    const sessionId = (init.raw as any).session_id as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.t.events().some((e) => (e.raw as any).type === "result" && (e.raw as any).is_error === false)).toBe(true);

    await turn(one.t, "m2", "Use the Bash tool to run `echo bridge-live-ok`, then tell me what it printed.", 2);
    const raw = JSON.stringify(one.t.events().map((e) => e.raw));
    expect(raw).toContain('"tool_use"');
    expect(raw).toContain("bridge-live-ok");

    // flush, then "sleep": a brand-new bridge process resumes the stored session
    one.t.emit([{ cid: "fl", frame: { t: "flush" } }]);
    await waitFor(() => one.t.of("flushed").length, "flushed");
    await one.b.stop(1000);

    const two = await boot(state, work, remote.baseUrl, sessionId, home);
    await turn(two.t, "m3", "What single word did I ask you to reply with in my first message?", 1);
    expect(assistantText(two.t)).toContain("PONG");
    expect(((two.t.events().find((e) => (e.raw as any).subtype === "init")!.raw) as any).session_id).toBe(sessionId);
    expect(join(work, "acme/demo")).toBeTruthy();
  }, 300_000);
});
