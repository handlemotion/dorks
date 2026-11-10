#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (result) => send({ id: m.id, result });
  if (m.method === "initialize") return reply({});
  if (m.method === "account/read") return reply({ account: existsSync(auth) ? { type: "chatgpt", planType: "plus" } : null, requiresOpenaiAuth: true });
  if (m.method === "model/list") return reply({ data: [{
    id: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
    model: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  }], nextCursor: null });
  if (m.method === "account/logout") {
    if (existsSync(auth)) unlinkSync(auth);
    reply({});
    send({ method: "account/updated", params: { authMode: null } });
    return;
  }
  if (m.method === "account/login/start") {
    reply({ type: "chatgptDeviceCode", loginId: "login_fake", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
    setTimeout(() => {
      if (process.env.FAKE_CODEX_LOGIN_FAIL) {
        send({ method: "account/login/completed", params: { loginId: "login_fake", success: false } });
        return;
      }
      mkdirSync(home, { recursive: true });
      writeFileSync(auth, "{}");
      send({ method: "account/login/completed", params: { loginId: "login_fake", success: true } });
    }, 250);
    return;
  }
  if (m.method === "thread/start") {
    mkdirSync(home, { recursive: true });
    writeFileSync(thread, "thr_fake");
    return reply({ thread: { id: "thr_fake" } });
  }
  if (m.method === "thread/resume") {
    if (existsSync(thread)) return reply({ thread: { id: "thr_fake" } });
    return send({ id: m.id, error: { code: -32602, message: "thread not found" } });
  }
  if (m.method === "turn/start") {
    const id = `turn_${++turnId}`;
    const prompt = m.params.input?.[0]?.text || "";
    if (process.env.FAKE_CODEX_REPORT) {
      const report = JSON.parse(readFileSync(process.env.FAKE_CODEX_REPORT, "utf8"));
      writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ ...report, model: m.params.model, effort: m.params.effort, sandboxPolicy: m.params.sandboxPolicy }));
    }
    reply({ turn: { id, status: "inProgress" } });
    active = true;
    setTimeout(() => {
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
    }, 30);
    return;
  }
  if (m.method === "turn/interrupt") {
    reply({});
    if (active) send({ method: "turn/completed", params: { turn: { id: m.params.turnId, status: "interrupted" } } });
    active = false;
  }
});
