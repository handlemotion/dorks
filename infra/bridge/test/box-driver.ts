// Runs INSIDE a real Upstash box (infra/bridge/scripts/box-mcp-check.sh): the real Bridge class and the real Claude CLI of the box, with the stand-in
// backend (FakeTransport), because a box cannot reach a backend on someone's machine. Bundled by scripts/box-mcp-check.sh.
//   env: CLAUDE_CODE_OAUTH_TOKEN, DRIVER_CLI (the installed dorks-bridge bundle the MCP config must point at)
import { mkdirSync } from "node:fs";
import { Bridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { makeLogger, Redactor } from "../src/redact";
import { FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const cli = process.env.DRIVER_CLI;
if (!token || !cli) throw new Error("CLAUDE_CODE_OAUTH_TOKEN and DRIVER_CLI are required");

const remote = makeRemote();
const home = tmp("box-home-");
mkdirSync(home, { recursive: true });
const hostEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, DORK_ID: "box_1", BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET: "c".repeat(64),
  DORKS_STATE_DIR: tmp("box-state-"), DORKS_WORKDIR: tmp("box-work-"), DORKS_GIT_BASE_URL: remote.baseUrl,
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
};
const t = new FakeTransport();
t.configureFrame = { t: "configure", ghToken: "ghs_unused", repo: { fullName: "acme/demo", branch: "dork/box" }, resumeSessionId: null, env: { CLAUDE_CODE_OAUTH_TOKEN: token } };
const redactor = new Redactor();
const logs: string[] = [];
const bridge = new Bridge({ cfg: loadConfig(hostEnv), transport: t, log: makeLogger("box", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, cli] });
await bridge.start();
t.emit([{ cid: "cfg", frame: { t: "fetch_configure" } }]);
await waitFor(() => t.of("ready").length, "ready", 60_000);
t.emit([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "Call the pr_subscribe tool of the dorks MCP server with pr acme/demo#9, then call the pr_list tool of the same server. Finish by replying with the word DONE and the PR you listed." } }]);
await waitFor(() => t.events().some((e) => (e.raw as any).state === "idle" && t.events().some((x) => (x.raw as any).type === "result")), "turn idle", 180_000);

const used = t.events().flatMap((e) => ((e.raw as any).message?.content ?? []) as { type: string; name?: string }[]).filter((b) => b.type === "tool_use").map((b) => b.name);
const text = t.events().filter((e) => (e.raw as any).type === "assistant").map((e) => JSON.stringify((e.raw as any).message.content)).join("\n");
const result = { mcpToolsUsed: used.filter((n) => n?.startsWith("mcp__")), prCalls: t.prCalls, saysDone: text.includes("DONE"), mentionsPr: text.includes("acme/demo#9"), whoami: process.env.USER ?? null, node: process.version };
console.log("RESULT " + JSON.stringify(result));
await bridge.stop(1000);
const ok = JSON.stringify(result.mcpToolsUsed) === '["mcp__dorks__pr_subscribe","mcp__dorks__pr_list"]' && t.prCalls.length === 1 && t.prCalls[0]!.op === "sub" && result.mentionsPr;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
