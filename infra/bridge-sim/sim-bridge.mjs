// Stand-in for the in-box bridge, speaking the same protocol (packages/shared/src/bridge.ts) over the server's bridge WebSocket
// (docs/architecture.md, "Bridge protocol") without Claude, git or a sandbox.
// Usage: DORK_ID=… BRIDGE_SECRET=… BRIDGE_URL=ws://127.0.0.1:4748/bridge node sim-bridge.mjs
//   commands  <- the server's commands snapshot (pushed on every change)
//   frames    -> the push rpc, batched (assistant text deltas coalesce for DELTA_BATCH_MS)
//   secrets   <- the configure / gh_token rpcs (never in the snapshot)

const { DORK_ID: dorkId, BRIDGE_SECRET: secret, BRIDGE_URL: url } = process.env;
const DELTA_BATCH_MS = Number(process.env.DELTA_BATCH_MS ?? 150);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);
const DELTAS = Number(process.env.SIM_DELTAS ?? 40); // fake text deltas per turn
const DELTA_GAP_MS = Number(process.env.SIM_DELTA_GAP_MS ?? 40);
if (!dorkId || !secret || !url) throw new Error("DORK_ID, BRIDGE_SECRET and BRIDGE_URL are required");

// ---- a minimal client for the bridge protocol: auth frame, rpc request/response, snapshot pushes, reconnect with backoff
let ws = null;
let nextId = 1;
const pendingRpc = new Map();
let onCommandsCb = null;
let lastCmds = null; // a snapshot can arrive before the handler is registered
let lastOpened = false;
const openSocket = () =>
  new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onopen = () => sock.send(JSON.stringify({ t: "auth", dorkId, secret }));
    sock.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.t === "auth_ok") {
        ws = sock;
        lastOpened = true;
        resolve();
      } else if (msg.t === "res") {
        const p = pendingRpc.get(msg.id);
        if (!p) return;
        pendingRpc.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error?.message ?? "rpc failed"), { data: msg.error }));
      } else if (msg.t === "commands") {
        lastCmds = msg.cmds;
        onCommandsCb?.(msg.cmds);
      }
    };
    sock.onerror = () => reject(new Error("connection failed"));
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      for (const [id, p] of pendingRpc) {
        p.reject(new Error("connection lost"));
        pendingRpc.delete(id);
      }
      if (ev.code === 4403) {
        console.log("[bridge-sim] refused by the server");
        process.exit(0);
      }
      reject(new Error("connection closed"));
      if (lastOpened) setTimeout(() => reopen().catch(() => {}), 1000);
    };
  });
async function reopen() {
  for (let delay = 500; ; delay = Math.min(delay * 2, 10_000)) {
    try {
      await openSocket();
      await rpc("connect");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
async function rpc(op, args = {}) {
  if (!ws) await openSocket();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: "rpc", id, op, args }));
  });
}
const client = {
  mutation: (op, args) => rpc(op, args),
  action: (op, args) => rpc(op, args),
  onUpdate: (cb) => {
    onCommandsCb = cb;
    if (lastCmds) cb(lastCmds);
  },
};
const log = (...a) => console.log(`[bridge-sim ${dorkId.slice(-6)}]`, ...a);
let bseq = 0;
let sessionId = null;
const seenMsg = new Set();
const handled = new Set(); // command ids already processed (the subscription re-emits until the ack lands)

// ---- outbound: ordered queue, flushed at most every DELTA_BATCH_MS; deltas coalesce into one raw event
// Delivery is lossless: a batch is retried (capped backoff) until the backend accepts it, and the backend only accepts events
// numbered exactly stored+1 (bridge.push returns { ok: false, expectedBseq } on a gap), so unconfirmed events stay in `history`
// and are replayed from `expectedBseq`. Limits: bridge.push takes at most 500 frames per call.
const MAX_FRAMES_PER_PUSH = 400;
const MAX_EVENT_BYTES = 256 * 1024; // the backend rejects a push holding a bigger event (`event_too_large`)
const BASE_BACKOFF_MS = Number(process.env.PUSH_BACKOFF_MS ?? 500);
const MAX_BACKOFF_MS = 15_000;
let queue = [];
let history = []; // event frames not yet confirmed by the backend, ascending bseq
let deltaText = "";
let timer = null;
let pushing = Promise.resolve();
const eventFrame = (raw) => {
  const frame = { t: "event", bseq: ++bseq, raw };
  if (eventBytes(frame) > MAX_EVENT_BYTES) truncate(frame);
  queue.push(frame);
  history.push(frame);
};
const deltaRaw = (text) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const eventBytes = (f) => new TextEncoder().encode(JSON.stringify(f.raw)).length;
// An event that can never be accepted is replaced in place by a stub with the same bseq: dropping it would leave a gap, and
// retrying it would wedge every frame queued behind it (turn_idle, acks, flushed).
const truncate = (f) => {
  log(`event ${f.bseq} too large, sending a truncation stub`);
  f.raw = { type: "truncated", truncated: true, was: String(f.raw?.type ?? "unknown") };
};

async function pushAll(frames) {
  for (let i = 0; i < frames.length; i += MAX_FRAMES_PER_PUSH) await pushChunk(frames.slice(i, i + MAX_FRAMES_PER_PUSH));
}
async function pushChunk(chunk) {
  let lastGap = 0;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await client.mutation("push", { frames: chunk });
    } catch (e) {
      const code = e?.data?.code;
      if (code === "too_many_frames" && chunk.length > 1) {
        // split and send in order
        const half = chunk.length >> 1;
        await pushChunk(chunk.slice(0, half));
        return pushChunk(chunk.slice(half));
      }
      if (code === "event_too_large") {
        const big = chunk.filter((f) => f.t === "event" && eventBytes(f) > MAX_EVENT_BYTES);
        const victims = big.length
          ? big
          : chunk
              .filter((f) => f.t === "event")
              .sort((a, b) => eventBytes(b) - eventBytes(a))
              .slice(0, 1);
        if (victims.length) {
          victims.forEach(truncate);
          continue;
        }
      }
      log(`push failed (attempt ${attempt + 1}), retrying:`, String(code ?? e.message ?? e).slice(0, 120));
      await wait(Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
      continue;
    }
    if (r?.ok === false && typeof r.expectedBseq === "number") {
      // Gap: the backend stopped at expectedBseq. Resend everything from there, then this batch's control frames (idempotent).
      log("gap: backend expects bseq", r.expectedBseq);
      if (r.expectedBseq === lastGap) await wait(Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)); // not advancing: do not hot-loop
      lastGap = r.expectedBseq;
      const replay = history.filter((f) => f.bseq >= r.expectedBseq);
      if (!replay.length || replay[0].bseq !== r.expectedBseq) log(`cannot replay from ${r.expectedBseq} (oldest unconfirmed: ${history[0]?.bseq})`);
      return pushAll([...replay, ...chunk.filter((f) => f.t !== "event")]);
    }
    const top = chunk.reduce((m, f) => (f.t === "event" ? Math.max(m, f.bseq) : m), 0);
    history = history.filter((f) => f.bseq > top); // confirmed
    return r;
  }
}

const flushNow = () => {
  clearTimeout(timer);
  timer = null;
  if (deltaText) {
    eventFrame(deltaRaw(deltaText));
    deltaText = "";
  }
  if (!queue.length) return pushing;
  const frames = queue;
  queue = [];
  pushing = pushing.then(() => pushAll(frames));
  return pushing;
};
const schedule = () => (timer ??= setTimeout(flushNow, DELTA_BATCH_MS));
const ev = (raw) => {
  if (raw.type === "stream_event" && raw.event?.type === "content_block_delta" && raw.event.delta?.type === "text_delta") {
    deltaText += raw.event.delta.text;
    return schedule();
  }
  if (deltaText) {
    // keep order: pending text goes out before whatever comes next
    eventFrame(deltaRaw(deltaText));
    deltaText = "";
  }
  eventFrame(raw);
  schedule();
};
const sendNow = (frame) => {
  queue.push(frame);
  return flushNow();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let aborted = false;
// What a real bridge relays from the CLI's `initialize` answer.
const SIM_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SIM_MODELS = [
  { model: "default", name: "Default (recommended)", description: "Sim Opus 1", resolved: "sim-opus-1", efforts: SIM_EFFORTS },
  { model: "opus", name: "Sim Opus 1", description: "The thorough one", resolved: "sim-opus-1", efforts: SIM_EFFORTS },
  { model: "haiku", name: "Sim Haiku 1", description: "The quick one", resolved: "sim-haiku-1", efforts: SIM_EFFORTS },
];

async function runTurn(text) {
  const n = bseq;
  const mid = `m${n}`;
  ev({ type: "stream_event", event: { type: "message_start", message: { id: mid } } });
  aborted = false;
  for (let i = 0; i < DELTAS && !aborted; i++) {
    ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `w${i} ` } } });
    await sleep(DELTA_GAP_MS);
  }
  if (aborted) {
    // like the CLI after an interrupt control_request: an error result, then idle
    ev({ type: "result", subtype: "error_during_execution", duration_ms: 5, is_error: true, result: "interrupted" });
    ev({ type: "system", subtype: "session_state_changed", state: "idle" });
    return void (await flushNow());
  }
  ev({
    type: "assistant",
    message: {
      id: mid,
      content: [
        { type: "text", text: `Done: ${text}` },
        { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "git push" } },
      ],
    },
  });
  ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] } });
  ev({ type: "assistant", message: { id: `${mid}f`, content: [{ type: "text", text: `Finished: ${text}. Pushed the branch; nothing else is pending.` }] } });
  ev({ type: "result", duration_ms: DELTAS * DELTA_GAP_MS, is_error: false });
  ev({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flushNow();
}

async function configure(cid) {
  const cfg = await client.action("configure");
  if (!cfg) return log("configure refused (the backend recorded why)");
  log("configure: repo", cfg.repo.fullName, "branch", cfg.repo.branch, "resume", cfg.resumeSessionId, "env keys", Object.keys(cfg.env).join(","), "gh token", cfg.ghToken ? "yes" : "no");
  sessionId = cfg.resumeSessionId ?? `sim-session-${Date.now()}`; // a real bridge: `claude --resume <id>` when set
  const model = SIM_MODELS.find((m) => m.model === (cfg.model ?? "default"))?.resolved ?? cfg.model;
  ev({ type: "system", subtype: "init", session_id: sessionId, ...(cfg.provider !== "codex" ? { model } : {}) });
  queue.push({ t: "ack", id: cid }, { t: "ready" });
  // The real bridge asks Haiku (or a light Codex model) for this; the sim names the dork after the first few words.
  if (cfg.nameFrom) queue.push({ t: "title", text: `Sim: ${cfg.nameFrom.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ")}`.slice(0, 120) });
  if (cfg.provider !== "codex") queue.push({ t: "agent_models", models: SIM_MODELS, effort: cfg.effort ?? null });
  return void flushNow();
}

/** Acks a message-carrying command and runs its turn once, however often it is redelivered. */
async function turnOnce(f, label, text) {
  await sendNow({ t: "ack", id: f.id });
  if (seenMsg.has(f.id)) return;
  seenMsg.add(f.id);
  log(label);
  return runTurn(text);
}

const commands = {
  fetch_configure: (f, cid) => configure(cid),
  user_message: (f) => turnOnce(f, `message: ${f.text}`, f.text),
  // autonomy digest (CI failed, review, conflict...): the real bridge writes it to Claude as one user turn
  notify: (f) => turnOnce(f, `notify: ${(f.kinds ?? []).join(",") || "-"}`, `notify ${(f.kinds ?? []).join(",")}`),
  interrupt: (f, cid) => {
    log("interrupt");
    aborted = true;
    return void sendNow({ t: "ack", id: cid });
  },
  flush: async (f, cid) => {
    log("flush");
    await flushNow();
    return void sendNow({ t: "ack", id: cid }).then(() => sendNow({ t: "flushed", cid }));
  },
  fetch_gh_token: async (f, cid) => {
    const r = await client.action("gh_token");
    log("gh token refreshed:", r ? "ok" : "failed");
    return void sendNow({ t: "ack", id: cid });
  },
};

async function onCommand({ cid, frame: f }) {
  if (handled.has(cid)) return;
  handled.add(cid);
  return commands[f.t]?.(f, cid);
}

try {
  const hello = await client.mutation("connect");
  bseq = Math.max(bseq, hello.afterBridgeSeq); // a fresh box restarts at 0 but must continue the stored numbering
  log("connected, numbering from", bseq + 1);
} catch (e) {
  log("connect refused:", String(e.data?.code ?? e.message).slice(0, 60));
  process.exit(0);
}
client.onUpdate((cmds) => {
  for (const c of cmds) onCommand(c).catch((e) => log("command failed:", String(e.message).slice(0, 120)));
});
setInterval(() => client.mutation("heartbeat").catch(() => {}), HEARTBEAT_MS).unref();
process.on("SIGTERM", async () => {
  await Promise.race([flushNow(), wait(2000)]);
  process.exit(0);
}); // bounded: a backend that is down must not make the sim unkillable
