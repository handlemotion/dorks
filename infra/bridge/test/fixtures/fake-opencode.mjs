#!/usr/bin/env node
// A stand-in for `opencode serve` (OpenCode 1.19.3, the classic /session + /event API). Event shapes, ordering and quirks copy captures of
// the real server driving a mock provider (test/fixtures/opencode/*.jsonl): text arrives as an empty text part, `message.part.delta`
// chunks, then the final part with `time.end`; a tool part goes pending -> running -> completed; an abort sends `session.error`
// (MessageAbortedError), idle, the final message update, and idle again. Sessions persist in $XDG_DATA_HOME/opencode/opencode.db.
//
// Test hooks:
//   FAKE_OPENCODE_REPORT=<file>   rewritten after every request: {argv, cwd, envKeys, config, prompts, aborts, permissionReplies, overlaps}
//   prompt text "SLOW"            stream deltas until aborted
//   prompt text "BADKEY"          the provider refuses the key (session.error APIError), then idle
//   prompt text "PERMISSION"      the bash call asks for permission and waits for the reply
//   prompt text "PRCREATE"        the bash call is `gh pr create`, printing a PR URL
//   FAKE_OPENCODE_CRASH=1         exit(3) right after the ready line
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.env.XDG_DATA_HOME || join(process.env.HOME || "/tmp", ".local", "share"), "opencode");
const db = join(dataDir, "opencode.db");
mkdirSync(dataDir, { recursive: true });
const sessions = (() => {
  try {
    return JSON.parse(readFileSync(db, "utf8"));
  } catch {
    return {};
  }
})();
const save = () => writeFileSync(db, JSON.stringify(sessions));

const report = { argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "null"), prompts: [], aborts: 0, permissionReplies: [], overlaps: 0 };
const writeReport = () => process.env.FAKE_OPENCODE_REPORT && writeFileSync(process.env.FAKE_OPENCODE_REPORT, JSON.stringify(report));
writeReport();

const clients = new Set();
let n = 0;
const id = (p) => `${p}_fake${String(++n).padStart(6, "0")}`;
const send = (type, properties) => {
  const line = `data: ${JSON.stringify({ id: id("evt"), type, properties })}\n\n`;
  for (const c of clients) c.write(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = Number(process.env.FAKE_OPENCODE_GAP_MS ?? 10);

const running = new Map(); // sessionID -> { aborted, assistant }
const waitingPermission = new Map(); // permission id -> resolve

async function turn(sessionID, text) {
  if (running.has(sessionID)) report.overlaps++;
  const t = { aborted: false, assistant: id("msg") };
  running.set(sessionID, t);
  const user = id("msg");
  send("message.updated", { sessionID, info: { id: user, role: "user", sessionID, time: { created: Date.now() } } });
  send("message.part.updated", { sessionID, part: { id: id("prt"), messageID: user, sessionID, type: "text", text } });
  send("session.status", { sessionID, status: { type: "busy" } });
  const a = t.assistant;
  send("message.updated", { sessionID, info: { id: a, role: "assistant", sessionID, parentID: user, time: { created: Date.now() } } });
  send("message.part.updated", { sessionID, part: { id: id("prt"), messageID: a, sessionID, type: "step-start" } });

  if (/BADKEY/.test(text)) {
    const error = { name: "APIError", data: { message: "invalid x-api-key", statusCode: 401, isRetryable: false } };
    send("session.error", { sessionID, error });
    send("session.status", { sessionID, status: { type: "idle" } });
    send("session.idle", { sessionID });
    send("message.updated", { sessionID, info: { id: a, role: "assistant", sessionID, time: { created: 0, completed: Date.now() }, error } });
    send("session.idle", { sessionID });
    return running.delete(sessionID);
  }

  const textPart = id("prt");
  send("message.part.updated", { sessionID, part: { id: textPart, messageID: a, sessionID, type: "text", text: "", time: { start: Date.now() } } });
  let full = "";
  const slow = /SLOW/.test(text);
  for (let i = 0; slow ? !t.aborted && i < 3000 : i < 3; i++) {
    const d = `w${i} `;
    full += d;
    send("message.part.delta", { sessionID, messageID: a, partID: textPart, field: "text", delta: d });
    await sleep(GAP);
  }
  if (t.aborted) {
    send("session.error", { sessionID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } });
    send("session.status", { sessionID, status: { type: "idle" } });
    send("session.idle", { sessionID });
    send("message.part.updated", { sessionID, part: { id: textPart, messageID: a, sessionID, type: "text", text: full, time: { start: 0, end: Date.now() } } });
    send("message.updated", { sessionID, info: { id: a, role: "assistant", sessionID, time: { created: 0, completed: Date.now() }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    send("session.status", { sessionID, status: { type: "idle" } });
    send("session.idle", { sessionID });
    return running.delete(sessionID);
  }

  const call = id("call");
  const tool = id("prt");
  const command = /PRCREATE/.test(text) ? "gh pr create --fill" : "echo hi";
  const tp = (state) => send("message.part.updated", { sessionID, part: { id: tool, messageID: a, sessionID, type: "tool", tool: "bash", callID: call, state } });
  tp({ status: "pending", input: {}, raw: "" });
  tp({ status: "running", input: { command, description: "run it" }, time: { start: Date.now() } });
  send("message.part.updated", { sessionID, part: { id: textPart, messageID: a, sessionID, type: "text", text: full, time: { start: 0, end: Date.now() } } });
  let state = { status: "completed", input: { command }, output: /PRCREATE/.test(text) ? "https://github.com/acme/demo/pull/7\n" : "hi\n", time: { start: 0, end: Date.now() } };
  if (/PERMISSION/.test(text)) {
    const per = id("per");
    send("permission.asked", { id: per, sessionID, permission: "bash", patterns: [command], metadata: { command }, always: ["echo *"], tool: { messageID: a, callID: call } });
    const reply = await new Promise((r) => waitingPermission.set(per, r));
    if (reply.reply === "reject") state = { status: "error", input: { command }, error: `The user rejected permission to use this specific tool call with the following feedback: ${reply.message ?? ""}`, time: { start: 0, end: Date.now() } };
  }
  tp(state);
  send("message.part.updated", { sessionID, part: { id: id("prt"), messageID: a, sessionID, type: "step-finish", reason: "tool-calls" } });
  send("message.updated", { sessionID, info: { id: a, role: "assistant", sessionID, time: { created: 0, completed: Date.now() }, finish: "tool-calls" } });
  // second step: the answer
  const a2 = id("msg");
  send("message.updated", { sessionID, info: { id: a2, role: "assistant", sessionID, parentID: user, time: { created: Date.now() } } });
  const p2 = id("prt");
  send("message.part.updated", { sessionID, part: { id: p2, messageID: a2, sessionID, type: "text", text: "", time: { start: Date.now() } } });
  send("message.part.delta", { sessionID, messageID: a2, partID: p2, field: "text", delta: "done." });
  send("message.part.updated", { sessionID, part: { id: p2, messageID: a2, sessionID, type: "text", text: "done.", time: { start: 0, end: Date.now() } } });
  send("message.updated", { sessionID, info: { id: a2, role: "assistant", sessionID, time: { created: 0, completed: Date.now() }, finish: "stop" } });
  send("session.status", { sessionID, status: { type: "idle" } });
  send("session.idle", { sessionID });
  running.delete(sessionID);
}

const body = (req) => new Promise((r) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => r(b ? JSON.parse(b) : undefined));
});
const json = (res, code, v) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(v === undefined ? "" : JSON.stringify(v));
};

const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = password ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${password}`).toString("base64")}` : null;

const server = createServer(async (req, res) => {
  if (expected && req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  let m;
  try {
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", properties: {} })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      await body(req);
      const s = { id: id("ses"), title: "New session", directory: process.cwd(), time: { created: Date.now() } };
      sessions[s.id] = s;
      save();
      send("session.created", { sessionID: s.id, info: s });
      return json(res, 200, s);
    }
    if ((m = /^\/session\/([^/]+)$/.exec(url.pathname)) && req.method === "GET") {
      const s = sessions[decodeURIComponent(m[1])];
      return s ? json(res, 200, s) : json(res, 404, { name: "NotFoundError", data: { message: "Session not found" } });
    }
    if ((m = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname)) && req.method === "POST") {
      const sid = decodeURIComponent(m[1]);
      const b = await body(req);
      if (!sessions[sid]) return json(res, 404, {});
      report.prompts.push({ sessionID: sid, ...b });
      writeReport();
      res.writeHead(204).end();
      void turn(sid, b.parts.map((p) => p.text).join(""));
      return;
    }
    if ((m = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)) && req.method === "POST") {
      report.aborts++;
      writeReport();
      const t = running.get(decodeURIComponent(m[1]));
      if (t) t.aborted = true;
      return json(res, 200, true);
    }
    if ((m = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname)) && req.method === "POST") {
      const b = await body(req);
      report.permissionReplies.push({ id: decodeURIComponent(m[1]), ...b });
      writeReport();
      waitingPermission.get(decodeURIComponent(m[1]))?.(b);
      return json(res, 200, true);
    }
    // like the real server: unknown paths answer 200 with the web UI
    res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

const argv = process.argv.slice(2);
const port = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 0;
server.listen(port, "127.0.0.1", () => {
  if (!password) process.stdout.write("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n");
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
  if (process.env.FAKE_OPENCODE_CRASH) process.exit(3);
});
process.on("SIGTERM", () => process.exit(0));
