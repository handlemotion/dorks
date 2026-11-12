#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
const auth = join(home, "auth.json");
const thread = join(home, "thread.json");
if (process.env.FAKE_CODEX_REPORT) writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({
  args: process.argv.slice(2), envKeys: Object.keys(process.env), cwd: process.cwd(), home, pid: process.pid,
}));
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let turnId = 0;
let active = false;
const models = () => [{
  id: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
  model: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
}, ...(process.env.FAKE_CODEX_LUNA ? [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }] : [])];

function startThread(m, reply) {
  if (existsSync(thread)) return reply({ thread: { id: `thr_side_${++turnId}` } }); // a side thread (the title)
  mkdirSync(home, { recursive: true });
  writeFileSync(thread, "thr_fake");
  return reply({ thread: { id: "thr_fake" } });
}

function sideTurn(m, reply) {
  const id = `turn_${++turnId}`;
  const p = { threadId: m.params.threadId, turnId: id };
  if (process.env.FAKE_CODEX_REPORT) writeFileSync(`${process.env.FAKE_CODEX_REPORT}.side`, JSON.stringify({ model: m.params.model, effort: m.params.effort, sandboxPolicy: m.params.sandboxPolicy }));
  reply({ turn: { id, status: "inProgress" } });
  send({ method: "item/completed", params: { ...p, item: { type: "agentMessage", id: `msg_${id}`, text: "\"Fix the flaky login tests.\"" } } });
  send({ method: "turn/completed", params: { ...p, turn: { id, status: "completed" } } });
}

function playTurn(id, prompt) {
  if (!active) return;
  send({ method: "turn/started", params: { turn: { id } } });
  if (process.env.FAKE_CODEX_WAIT) return;
  if (process.env.FAKE_CODEX_TURN_FAILED) {
    send({ method: "turn/completed", params: { turn: { id, status: "failed", error: { message: "ChatGPT plan limit reached" } } } });
    active = false;
    return;
  }
  send({ method: "item/started", params: { item: { type: "agentMessage", id: `msg_${id}` } } });
  send({ method: "item/agentMessage/delta", params: { itemId: `msg_${id}`, delta: "Done: " } });
  send({ method: "item/started", params: { item: { type: "commandExecution", id: `cmd_${id}`, command: "git status" } } });
  send({ method: "item/completed", params: { item: { type: "commandExecution", id: `cmd_${id}`, command: "git status", exitCode: 0, aggregatedOutput: "clean" } } });
  send({ method: "item/completed", params: { item: { type: "agentMessage", id: `msg_${id}`, text: `Done: ${prompt}` } } });
  send({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
  active = false;
}

function startTurn(m, reply) {
  if (m.params.threadId !== "thr_fake") return sideTurn(m, reply);
  const id = `turn_${++turnId}`;
  const prompt = m.params.input?.[0]?.text || "";
  if (process.env.FAKE_CODEX_REPORT) {
    const report = JSON.parse(readFileSync(process.env.FAKE_CODEX_REPORT, "utf8"));
    writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ ...report, model: m.params.model, effort: m.params.effort, sandboxPolicy: m.params.sandboxPolicy }));
  }
  reply({ turn: { id, status: "inProgress" } });
  active = true;
  setTimeout(() => playTurn(id, prompt), 30);
}

const handlers = {
  initialize: (m, reply) => reply({}),
  "account/read": (m, reply) => reply({ account: existsSync(auth) ? { type: "chatgpt", planType: "plus" } : null, requiresOpenaiAuth: true }),
  "model/list": (m, reply) => reply({ data: models(), nextCursor: null }),
  "thread/start": startThread,
  "thread/resume": (m, reply) => existsSync(thread) ? reply({ thread: { id: "thr_fake" } }) : send({ id: m.id, error: { code: -32602, message: "thread not found" } }),
  "turn/start": startTurn,
  "turn/interrupt": (m, reply) => {
    reply({});
    if (active) send({ method: "turn/completed", params: { turn: { id: m.params.turnId, status: "interrupted" } } });
    active = false;
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  handlers[m.method]?.(m, (result) => send({ id: m.id, result }));
});
