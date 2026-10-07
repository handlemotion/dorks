// Stand-in for the in-box bridge, speaking the same protocol (packages/shared/src/bridge.ts) over Convex instead of a WebSocket.
// Usage: DORK_ID=… BRIDGE_SECRET=… BRIDGE_URL=https://<deployment>.convex.cloud node convex-sim.mjs
//   commands  <- subscription to bridge.commands (reactive; replaces the DO socket)
//   frames    -> bridge.push mutation, batched (assistant text deltas coalesce for DELTA_BATCH_MS)
//   secrets   <- bridge.configure / bridge.ghToken actions (never in the subscription)
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

const { DORK_ID: dorkId, BRIDGE_SECRET: secret, BRIDGE_URL: url } = process.env;
const DELTA_BATCH_MS = Number(process.env.DELTA_BATCH_MS ?? 150);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);
const DELTAS = Number(process.env.SIM_DELTAS ?? 40); // fake text deltas per turn
const DELTA_GAP_MS = Number(process.env.SIM_DELTA_GAP_MS ?? 40);
if (!dorkId || !secret || !url) throw new Error("DORK_ID, BRIDGE_SECRET and BRIDGE_URL are required");

const api = anyApi;
const creds = { dorkId, secret };
const client = new ConvexClient(url);
const log = (...a) => console.log(`[bridge-sim ${dorkId.slice(-6)}]`, ...a);
let bseq = 0;
let sessionId = null;
const seenMsg = new Set();
const handled = new Set(); // command ids already processed (the subscription re-emits until the ack lands)

// ---- outbound: ordered queue, flushed at most every DELTA_BATCH_MS; deltas coalesce into one raw event
let queue = [];
let deltaText = "";
let timer = null;
let pushing = Promise.resolve();
const flushNow = () => {
  clearTimeout(timer);
  timer = null;
  if (deltaText) {
    queue.push({ t: "event", bseq: ++bseq, raw: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: deltaText } } } });
    deltaText = "";
  }
  if (!queue.length) return pushing;
  const frames = queue;
  queue = [];
  pushing = pushing.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.mutation(api.bridge.push, { ...creds, frames });
      } catch (e) {
        if (attempt > 4) return log("push failed, dropping batch:", String(e.message ?? e).slice(0, 120));
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  });
  return pushing;
};
const schedule = () => (timer ??= setTimeout(flushNow, DELTA_BATCH_MS));
const ev = (raw) => {
  if (raw.type === "stream_event" && raw.event?.type === "content_block_delta" && raw.event.delta?.type === "text_delta") {
    deltaText += raw.event.delta.text;
    return schedule();
  }
  if (deltaText) { // keep order: pending text goes out before whatever comes next
    queue.push({ t: "event", bseq: ++bseq, raw: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: deltaText } } } });
    deltaText = "";
  }
  queue.push({ t: "event", bseq: ++bseq, raw });
  schedule();
};
const sendNow = (frame) => { queue.push(frame); return flushNow(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(text) {
  const n = bseq;
  const mid = `m${n}`;
  ev({ type: "stream_event", event: { type: "message_start", message: { id: mid } } });
  for (let i = 0; i < DELTAS; i++) { ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `w${i} ` } } }); await sleep(DELTA_GAP_MS); }
  ev({ type: "assistant", message: { id: mid, content: [{ type: "text", text: `Done: ${text}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "git push" } }] } });
  ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] } });
  ev({ type: "result", duration_ms: DELTAS * DELTA_GAP_MS, is_error: false });
  ev({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flushNow();
}

async function onCommand({ cid, frame: f }) {
  if (handled.has(cid)) return;
  handled.add(cid);
  switch (f.t) {
    case "fetch_configure": {
      const cfg = await client.action(api.bridge.configure, creds);
      if (!cfg) return log("configure refused (the backend recorded why)");
      log("configure: repo", cfg.repo.fullName, "branch", cfg.repo.branch, "resume", cfg.resumeSessionId, "env keys", Object.keys(cfg.env).join(","), "gh token", cfg.ghToken ? "yes" : "no");
      sessionId = cfg.resumeSessionId ?? `sim-session-${Date.now()}`; // a real bridge: `claude --resume <id>` when set
      ev({ type: "system", subtype: "init", session_id: sessionId });
      queue.push({ t: "ack", id: cid }, { t: "ready" });
      return void flushNow();
    }
    case "user_message": {
      await sendNow({ t: "ack", id: f.id });
      if (seenMsg.has(f.id)) return;
      seenMsg.add(f.id);
      log("message:", f.text);
      return runTurn(f.text);
    }
    case "interrupt": log("interrupt"); return void sendNow({ t: "ack", id: cid });
    case "flush": log("flush"); await flushNow(); return void sendNow({ t: "ack", id: cid }).then(() => sendNow({ t: "flushed" }));
    case "fetch_gh_token": { const r = await client.action(api.bridge.ghToken, creds); log("gh token refreshed:", r ? "ok" : "failed"); return void sendNow({ t: "ack", id: cid }); }
  }
}

try {
  const hello = await client.mutation(api.bridge.connect, creds);
  bseq = Math.max(bseq, hello.afterBridgeSeq); // a fresh box restarts at 0 but must continue the stored numbering
  log("connected, numbering from", bseq + 1);
} catch (e) {
  log("connect refused:", String(e.data?.code ?? e.message).slice(0, 60));
  process.exit(0);
}
client.onUpdate(api.bridge.commands, creds, (cmds) => { for (const c of cmds) onCommand(c).catch((e) => log("command failed:", String(e.message).slice(0, 120))); }, (e) => log("subscription error:", String(e.message).slice(0, 120)));
setInterval(() => client.mutation(api.bridge.heartbeat, creds).catch(() => {}), HEARTBEAT_MS).unref();
process.on("SIGTERM", async () => { await flushNow(); process.exit(0); });
