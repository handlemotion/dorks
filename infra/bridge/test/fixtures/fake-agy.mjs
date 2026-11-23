#!/usr/bin/env node
// A stand-in for Google's `agy` with the documented headless stream-json protocol (antigravity.google/docs/cli/headless).
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME;
const report = process.env.FAKE_AGY_REPORT;
const tokenFile = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
if (report)
  appendFileSync(
    report,
    JSON.stringify({
      args,
      envKeys: Object.keys(process.env),
      token: existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : null,
      mcp: existsSync(join(home, ".gemini", "config", "mcp_config.json")) ? JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")) : null,
      rule: existsSync(join(home, ".gemini", "config", "rules", "dorks.md")) ? readFileSync(join(home, ".gemini", "config", "rules", "dorks.md"), "utf8") : null,
    }) + "\n",
  );
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

if (args[0] === "models") {
  process.stdout.write("gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n"); // piped: tab-separated
  process.exit(0);
}
if (args[0] === "-p") {
  send({ conversation_id: "side", status: "SUCCESS", response: "Fix the flaky login tests\n", num_turns: 1 });
  process.exit(0);
}
if (!existsSync(tokenFile)) {
  process.stderr.write("error: authentication required\n");
  process.exit(1);
}
const at = args.indexOf("--conversation");
const conversation = at >= 0 ? args[at + 1] : "conv_fake";
send({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "always-proceed" } });
let step = 0;
let turns = 0;
process.on("SIGINT", () => process.exit(130));
const step_update = (s) => send({ event: "step_update", step_update: { conversation_id: conversation, step_index: step++, ...s } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const prompt = typeof m.message.content === "string" ? m.message.content : m.message.content.map((b) => b.text).join("");
  if (report) appendFileSync(report, JSON.stringify({ prompt }) + "\n");
  step_update({ state: "DONE", step_type: "user_input" });
  if (process.env.FAKE_AGY_WAIT && !prompt.includes("again")) return; // a long turn, until SIGINT
  step_update({ state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\n" } });
  const id = step++;
  send({ event: "step_update", step_update: { conversation_id: conversation, step_index: id, state: "ACTIVE", step_type: "agent_response", text_delta: "Done: " } });
  send({ event: "step_update", step_update: { conversation_id: conversation, step_index: id, state: "DONE", step_type: "agent_response", text_delta: prompt.split("\n").pop() } });
  send({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: `Done: ${prompt}`, num_turns: ++turns } });
});
