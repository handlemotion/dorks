#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
const auth = join(home, "auth.json");
const thread = join(home, "thread.json");
if (process.env.FAKE_CODEX_REPORT)
  writeFileSync(
    process.env.FAKE_CODEX_REPORT,
    JSON.stringify({
      args: process.argv.slice(2),
      envKeys: Object.keys(process.env),
      cwd: process.cwd(),
      home,
      pid: process.pid,
    }),
  );
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let turnId = 0;
let active = false;
/** Signed in with a token the bridge supplied (`chatgptAuthTokens`), in memory only like the real app-server. */
let tokenLogin = null;
let experimental = false;
let activeTurn = null;
/** Appends one line to the report's log: what the bridge sent (thread settings, turn input, steers). */
const note = (entry) => process.env.FAKE_CODEX_REPORT && appendFileSync(`${process.env.FAKE_CODEX_REPORT}.log`, `${JSON.stringify(entry)}\n`);
let extraRoots = [];
const models = () => [
  {
    id: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
    model: process.env.FAKE_CODEX_MODEL_MISSING ? "gpt-6.1-sol" : "gpt-6-sol",
    displayName: "GPT-6 Sol",
    description: "The thorough one",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
  },
  ...(process.env.FAKE_CODEX_LUNA ? [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }] : []),
];

function startThread(m, reply) {
  if (m.params.ephemeral) return reply({ thread: { id: `thr_side_${++turnId}` } }); // a side thread (the title, the verify judge)
  note({ method: "thread/start", developerInstructions: m.params.developerInstructions, config: m.params.config });
  mkdirSync(home, { recursive: true });
  writeFileSync(thread, "thr_fake");
  return reply({ thread: { id: "thr_fake" } });
}

function sideTurn(m, reply) {
  const id = `turn_${++turnId}`;
  const p = { threadId: m.params.threadId, turnId: id };
  const prompt = m.params.input?.[0]?.text || "";
  const judging = prompt.includes('"verdict"');
  note({ method: "side", judging, model: m.params.model });
  if (process.env.FAKE_CODEX_REPORT && !judging)
    writeFileSync(`${process.env.FAKE_CODEX_REPORT}.side`, JSON.stringify({ model: m.params.model, effort: m.params.effort, sandboxPolicy: m.params.sandboxPolicy }));
  reply({ turn: { id, status: "inProgress" } });
  const answer = judging ? JSON.stringify({ verdict: process.env.FAKE_CODEX_VERDICT || "verified", what: "Start the server and curl /health." }) : '"Fix the flaky login tests."';
  send({ method: "item/completed", params: { ...p, item: { type: "agentMessage", id: `msg_${id}`, text: answer } } });
  send({ method: "turn/completed", params: { ...p, turn: { id, status: "completed" } } });
}

const steers = [];
let refreshed = false;
let afterRefresh = null;
function playTurn(id, prompt) {
  if (!active) return;
  send({ method: "turn/started", params: { threadId: "thr_fake", turn: { id } } });
  if (process.env.FAKE_CODEX_WAIT) return;
  if (process.env.FAKE_CODEX_SLOW) return void setTimeout(() => finishTurn(id, prompt), Number(process.env.FAKE_CODEX_SLOW));
  finishTurn(id, prompt);
}

function finishTurn(id, prompt) {
  if (!active) return;
  // The token expired mid-turn: Codex asks its client for a new one (the real app-server does this on a 401).
  if (process.env.FAKE_CODEX_REFRESH && tokenLogin && !refreshed) {
    refreshed = true;
    send({ id: 9001, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "acct_test" } });
    return void (afterRefresh = () => finishTurn(id, prompt));
  }
  if (process.env.FAKE_CODEX_EDIT) {
    send({
      method: "turn/plan/updated",
      params: {
        threadId: "thr_fake",
        turnId: id,
        plan: [
          { step: "Fix the bug", status: "inProgress" },
          { step: "Test it", status: "pending" },
        ],
      },
    });
    const change = { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" };
    send({ method: "item/started", params: { threadId: "thr_fake", item: { type: "fileChange", id: `fc_${id}`, changes: [change], status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thr_fake", item: { type: "fileChange", id: `fc_${id}`, changes: [change], status: "completed" } } });
    // An approval request Codex should never send with approvals off: answered, and never confused with the bridge's own ids.
    send({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thr_fake", turnId: id, itemId: "x" } });
  }
  if (process.env.FAKE_CODEX_TURN_FAILED) {
    send({ method: "turn/completed", params: { turn: { id, status: "failed", error: { message: "ChatGPT plan limit reached" } } } });
    active = false;
    return;
  }
  send({ method: "item/started", params: { item: { type: "agentMessage", id: `msg_${id}` } } });
  send({ method: "item/agentMessage/delta", params: { itemId: `msg_${id}`, delta: "Done: " } });
  send({ method: "item/started", params: { item: { type: "commandExecution", id: `cmd_${id}`, command: "git status" } } });
  send({ method: "item/completed", params: { item: { type: "commandExecution", id: `cmd_${id}`, command: "git status", exitCode: 0, aggregatedOutput: "clean" } } });
  const heard = steers
    .splice(0)
    .map((s) => ` (steered: ${s})`)
    .join("");
  send({ method: "item/completed", params: { item: { type: "agentMessage", id: `msg_${id}`, text: `Done: ${prompt}${heard}` } } });
  send({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
  active = false;
}

function startTurn(m, reply) {
  if (m.params.threadId !== "thr_fake") return sideTurn(m, reply);
  const id = `turn_${++turnId}`;
  // The message, without the bridge's briefing (an item of its own).
  const prompt = (m.params.input ?? [])
    .filter((i) => i.type === "text" && !i.text.startsWith("<system-reminder>"))
    .map((i) => i.text)
    .join(" ");
  note({ method: "turn/start", input: m.params.input });
  if (process.env.FAKE_CODEX_REPORT) {
    const report = JSON.parse(readFileSync(process.env.FAKE_CODEX_REPORT, "utf8"));
    writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ ...report, model: m.params.model, effort: m.params.effort, sandboxPolicy: m.params.sandboxPolicy }));
  }
  reply({ turn: { id, status: "inProgress" } });
  active = true;
  activeTurn = id;
  setTimeout(() => playTurn(id, prompt), 30);
}

const handlers = {
  // The bridge's answer to the approval request above: recorded, so a test can check it was declined.
  undefined: () => {},
  initialize: (m, reply) => {
    experimental = m.params.capabilities?.experimentalApi === true;
    reply({});
  },
  "account/login/start": (m, reply) => {
    if (m.params.type !== "chatgptAuthTokens") return send({ id: m.id, error: { code: -32600, message: "unsupported login" } });
    if (!experimental) return send({ id: m.id, error: { code: -32600, message: "account/login/start.chatgptAuthTokens requires experimentalApi capability" } });
    tokenLogin = m.params.accessToken;
    note({ method: "login", accessToken: m.params.accessToken, accountId: m.params.chatgptAccountId });
    reply({ type: "chatgptAuthTokens" });
  },
  "account/read": (m, reply) => reply({ account: tokenLogin || existsSync(auth) ? { type: "chatgpt", planType: "plus" } : null, requiresOpenaiAuth: true }),
  "model/list": (m, reply) => reply({ data: models(), nextCursor: null }),
  "thread/start": startThread,
  "thread/resume": (m, reply) => (existsSync(thread) ? reply({ thread: { id: "thr_fake" } }) : send({ id: m.id, error: { code: -32602, message: "thread not found" } })),
  "turn/start": startTurn,
  "turn/steer": (m, reply) => {
    if (!active || m.params.expectedTurnId !== activeTurn) return send({ id: m.id, error: { code: -32600, message: "no active turn to steer" } });
    note({ method: "turn/steer", input: m.params.input });
    steers.push(m.params.input.map((i) => i.text ?? "").join(" "));
    reply({ turnId: m.params.expectedTurnId });
  },
  "skills/extraRoots/set": (m, reply) => {
    extraRoots = m.params.extraRoots;
    reply({});
  },
  "skills/list": (m, reply) =>
    reply({
      data: [
        {
          cwd: m.params.cwds[0],
          skills: extraRoots.flatMap((root) => readdirSync(root).map((name) => ({ name, description: `skill ${name}`, path: `${root}/${name}/SKILL.md`, scope: "user", enabled: true }))),
          errors: [],
        },
      ],
    }),
  "turn/interrupt": (m, reply) => {
    reply({});
    if (active) send({ method: "turn/completed", params: { turn: { id: m.params.turnId, status: "interrupted" } } });
    active = false;
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && m.result !== undefined && m.id === 1 && m.result.decision) return note({ method: "approval", decision: m.result.decision });
  if (m.method === undefined && m.id === 9001) {
    tokenLogin = m.result?.accessToken ?? tokenLogin;
    note({ method: "refreshed", accessToken: m.result?.accessToken ?? null, error: m.error?.message ?? null });
    return afterRefresh?.();
  }
  handlers[m.method]?.(m, (result) => send({ id: m.id, result }));
});
