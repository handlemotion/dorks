#!/usr/bin/env node
// A stand-in for the Claude Code CLI in headless streaming mode (`-p --input-format stream-json --output-format stream-json
// --verbose --include-partial-messages`). Its events mirror the shapes the real CLI emits (checked against the Agent SDK types and a
// live unauthenticated run of v2.1.293; no paid session was recorded): per user
// turn a state change, init (once per process), message_start, text deltas, a full assistant message with a tool_use, the
// tool_result, a result and an idle state change. Interrupts, `--resume` and EOF behave like the real CLI.
//
// Test hooks (all via the child env, so they only exist when a test sets them):
//   FAKE_CLAUDE_DELTAS / FAKE_CLAUDE_GAP_MS   text deltas per turn / gap between them (defaults 40 / 40, like infra/bridge-sim)
//   FAKE_CLAUDE_REPORT=<file>                 at startup, write {argv, cwd, envKeys, env} as JSON
//   message text "crash"      -> exit(3) mid-turn;   "permission" -> ask the host for permission and report the answer
//   message text "noise"      -> emit events the bridge must not forward
//   FAKE_CLAUDE_NO_SESSION=start|message   with --resume: behave like the real CLI for an unknown session id ("No conversation found", exit 1)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);
const resume = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null;
// Like the real CLI's `initialize` answer: aliases with the full id they resolve to and the efforts they support.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = [
  { value: "default", resolvedModel: "fake-opus-1", displayName: "Default (recommended)", description: "Fake Opus 1", supportsEffort: true, supportedEffortLevels: EFFORTS },
  { value: "opus", resolvedModel: "fake-opus-1", displayName: "Fake Opus 1", description: "The thorough one", supportsEffort: true, supportedEffortLevels: EFFORTS },
  { value: "haiku", resolvedModel: "fake-haiku-1", displayName: "Fake Haiku 1", description: "The quick one", supportsEffort: true, supportedEffortLevels: EFFORTS },
];
const modelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "default";
const model = MODELS.find((m) => m.value === modelArg)?.resolvedModel ?? modelArg;
const sessionId = resume ?? randomUUID();
const DELTAS = Number(process.env.FAKE_CLAUDE_DELTAS ?? 40);
const GAP = Number(process.env.FAKE_CLAUDE_GAP_MS ?? 40);
if (process.env.FAKE_CLAUDE_REPORT) writeFileSync(process.env.FAKE_CLAUDE_REPORT, JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env), env: process.env, pid: process.pid }));

const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: sessionId })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// like the real CLI: <config dir>/projects/<encoded cwd>/<session>.jsonl (the bridge only resumes sessions it finds there)
const transcript = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/tmp", ".claude"), "projects", "-fake");
mkdirSync(transcript, { recursive: true });
const record = (o) => appendFileSync(join(transcript, `${sessionId}.jsonl`), `${JSON.stringify(o)}\n`);

if (resume && process.env.FAKE_CLAUDE_NO_SESSION === "start") {
  out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 0, result: `No conversation found with session ID: ${resume}` });
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
let inited = false;
let turn = 0;
let aborted = false;
let busy = false;
const queue = [];
const pendingControl = new Map();

async function runTurn(text) {
  if (resume && process.env.FAKE_CLAUDE_NO_SESSION === "message") {
    out({ type: "system", subtype: "session_state_changed", state: "running", uuid: randomUUID() });
    out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 0, result: `No conversation found with session ID: ${resume}` });
    process.exit(1);
  }
  busy = true;
  aborted = false;
  const n = ++turn;
  const mid = `msg_fake_${randomUUID().slice(0, 8)}_${n}`; // unique across restarts, like real message ids
  const tid = `toolu_fake_${n}`;
  record({ type: "user", text });
  out({ type: "system", subtype: "session_state_changed", state: "running", uuid: randomUUID() });
  if (!inited) {
    inited = true;
    out({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Read", "Edit"], mcp_servers: [], model, permissionMode: "bypassPermissions", apiKeySource: "none", uuid: randomUUID() });
  }
  out({ type: "system", subtype: "status", status: "requesting", uuid: randomUUID() });
  out({ type: "stream_event", event: { type: "message_start", message: { id: mid, role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } }, parent_tool_use_id: null, uuid: randomUUID() });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, uuid: randomUUID() });
  if (text === "crash") process.exit(3);
  if (text === "stderr-echo") {
    // a CLI that dumps its env to stderr on a fatal error: the bridge must neither log nor forward the secrets
    process.stderr.write(`echo-marker ${process.env.CLAUDE_CODE_OAUTH_TOKEN} ${process.env.CF_TOKEN}\n`);
    process.exit(1);
  }
  if (text === "noise") out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, parent_tool_use_id: null });
  if (text === "permission") {
    const rid = randomUUID();
    const answer = new Promise((r) => pendingControl.set(rid, r));
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" }, tool_use_id: "toolu_perm" } });
    const res = await answer;
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `permission:${res?.behavior}` } }, parent_tool_use_id: null });
  }
  for (let i = 0; i < DELTAS && !aborted; i++) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `w${i} ` } }, parent_tool_use_id: null, uuid: randomUUID() });
    await sleep(GAP);
  }
  if (aborted) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 5, result: "interrupted", uuid: randomUUID() });
  } else {
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null });
    out({ type: "assistant", message: { id: mid, type: "message", role: "assistant", model, content: [{ type: "text", text: `Done: ${text}` }, { type: "tool_use", id: tid, name: "Bash", input: { command: "git push", description: "push" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 9 } }, parent_tool_use_id: null, uuid: randomUUID() });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] }, parent_tool_use_id: null, uuid: randomUUID() });
    // The final answer: a text-only message after the last tool call.
    out({ type: "assistant", message: { id: `${mid}_final`, type: "message", role: "assistant", model, content: [{ type: "text", text: `Finished: ${text}. Pushed the branch; nothing else is pending.` }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 9 } }, parent_tool_use_id: null, uuid: randomUUID() });
    out({ type: "result", subtype: "success", is_error: false, duration_ms: DELTAS * GAP, duration_api_ms: 1, num_turns: 1, result: `Done: ${text}`, total_cost_usd: 0, uuid: randomUUID() });
  }
  out({ type: "system", subtype: "session_state_changed", state: "idle", uuid: randomUUID() });
  busy = false;
  drain();
}

function drain() {
  if (!busy && queue.length) void runTurn(queue.shift());
  else if (!busy && ended) process.exit(0);
}

let ended = false;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === "user") {
      const c = m.message?.content;
      queue.push(typeof c === "string" ? c : c.map((b) => b.text ?? "").join(""));
      drain();
    } else if (m.type === "control_request" && m.request?.subtype === "initialize") {
      process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: MODELS } } })}\n`);
    } else if (m.type === "control_request" && m.request?.subtype === "interrupt") {
      aborted = true;
      process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { still_queued: [] } } })}\n`);
    } else if (m.type === "control_response") {
      pendingControl.get(m.response?.request_id)?.(m.response?.response);
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  drain();
});
process.on("SIGTERM", () => process.exit(143));
