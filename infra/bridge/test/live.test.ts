// Opt-in: drives the REAL `claude` CLI through the bridge (fake transport, local git remote). Skipped unless a credential is present.
//   CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) pnpm --filter @dorks/bridge test live      (or ANTHROPIC_API_KEY=…)
// Costs a few cents: three short turns, plus one more test for the hooks. ANTHROPIC_BASE_URL is passed through (gateways, recorded runs). CLAUDE_BIN overrides the binary; LIVE_CLAUDE_ARGS adds flags (e.g. "--model haiku").
import type { SubscriptionView } from "@dorks/shared";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, fakeView, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!token && !apiKey)("real claude CLI through the bridge", () => {
  const bridges: Bridge[] = [];
  afterAll(async () => {
    for (const b of bridges) await b.stop(1000);
  });

  async function boot(state: string, work: string, remoteBase: string, resume: string | null, home: string, subscriptions: SubscriptionView[] = []) {
    // A clean HOME: the CLI must authenticate from the configured env alone, like in a fresh box. A paused box keeps its disk, so a
    // second boot of the same box reuses the same HOME (the session transcript lives there).
    mkdirSync(home, { recursive: true });
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, DORK_ID: "live_1", BRIDGE_URL: "wss://x.example/bridge", BRIDGE_SECRET: "c".repeat(64),
      DORKS_STATE_DIR: state, DORKS_SOCK_DIR: state, DORKS_WORKDIR: work, DORKS_GIT_BASE_URL: remoteBase, DORKS_CLAUDE_ARGS: process.env.LIVE_CLAUDE_ARGS ?? "",
      ...(process.env.CLAUDE_BIN ? { CLAUDE_BIN: process.env.CLAUDE_BIN } : {}),
      ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
    };
    const t = new FakeTransport();
    t.subscriptions = subscriptions;
    t.configureFrame = {
      t: "configure", ghToken: "ghs_live_unused", repo: { fullName: "acme/demo", branch: "dork/live" }, resumeSessionId: resume,
      env: { ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
    };
    const redactor = new Redactor();
    const logs: string[] = [];
    const b = new Bridge({ cfg: loadConfig(hostEnv), transport: t, log: makeLogger("live", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, builtCli()] }); // the hooks and the git helper run the built bundle
    bridges.push(b);
    await b.start();
    t.emit([{ cid: "cfg", frame: { t: "fetch_configure" } }]);
    await waitFor(() => t.of("ready").length, "ready");
    return { b, t, logs };
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

  // The hooks come from the settings file the bridge hands to `claude --settings` (src/hooks.ts). This is the proof that the real CLI runs
  // them under `-p --input-format stream-json`: SessionStart through what the model can say about its context, Stop through the bridge's
  // own log (a model cannot be made to report a hook's reason reliably).
  it("fires the SessionStart and Stop hooks from --settings", async () => {
    const remote = makeRemote();
    const work = tmp("live-work-");
    const title = "Hooks live check 7431";
    const live = await boot(tmp("live-state-"), work, remote.baseUrl, null, tmp("live-home-"), [{ ...fakeView({ repo: "acme/demo", number: 5 }), title }]);
    const dir = join(work, "acme/demo");
    // the repo's own hooks must keep running next to the bridge's: --settings merges, it does not replace
    const marker = join(tmp("live-marker-"), "repo-stop-hook-ran");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `touch '${marker}'` }] }] } }));
    writeFileSync(join(dir, "wip.txt"), "unpushed\n");
    remote.sh(dir, "add", ".");
    remote.sh(dir, "commit", "-q", "-m", "wip"); // a commit on dork/live that was never pushed: the Stop gate must object once

    await turn(live.t, "h1", "Reply with exactly the title of the pull request you are subscribed to, and nothing else.", 1);
    expect(assistantText(live.t)).toContain(title); // the SessionStart context reached the model
    expect(live.logs.filter((l) => l.includes("hook session-start:"))).toHaveLength(1);
    expect(live.logs.filter((l) => l.includes("hook stop: blocked for unpublished"))).toHaveLength(1); // blocked once, and the turn still ended
    expect(existsSync(marker)).toBe(true);
    expect(live.t.events().some((e) => (e.raw as any).type === "result" && (e.raw as any).is_error === false)).toBe(true);
  }, 300_000);
  // The dorks MCP server comes from the config the bridge hands to `claude --mcp-config` (src/mcp.ts). This is the proof that the real CLI
  // starts it, lists its tools and lets the model subscribe to a PR through it, all the way to the (fake) backend call.
  it("loads the dorks MCP server from --mcp-config and subscribes to a PR through its tools", async () => {
    const live = await boot(tmp("live-state-"), tmp("live-work-"), makeRemote().baseUrl, null, tmp("live-home-"));
    await turn(
      live.t,
      "mcp1",
      "Call the pr_subscribe tool of the dorks MCP server with pr acme/demo#9, then call the pr_list tool of the same server. Finish by replying with the word DONE and the PR you listed.",
      1,
    );
    expect(live.t.prCalls).toEqual([{ op: "sub", ref: { repo: "acme/demo", number: 9 }, source: "agent" }]);
    // the bridge forwards only a trimmed init event, so the tool calls themselves are the proof that the server started and its tools were listed
    const used = live.t.events().flatMap((e) => ((e.raw as any).message?.content ?? []) as { type: string; name?: string; input?: unknown }[]).filter((b) => b.type === "tool_use");
    expect(used.map((b) => b.name).filter((n) => n?.startsWith("mcp__"))).toEqual(["mcp__dorks__pr_subscribe", "mcp__dorks__pr_list"]); // the CLI defers MCP tools: the model may ToolSearch first
    expect(JSON.stringify(live.t.events().map((e) => e.raw))).toContain("Subscribed to acme/demo#9");
    expect(assistantText(live.t)).toContain("acme/demo#9");
  }, 300_000);
});
