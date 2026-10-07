// Local stand-in for the in-box bridge: dials the Worker, speaks the DO<->bridge protocol, and fakes Claude turns.
// Usage: node sim.mjs <dorkId> <bridgeSecret> [wss://host]   (reference for the real bridge daemon)
const [dorkId, secret, base = "ws://localhost:8787"] = process.argv.slice(2);
let bseq = 0;
let sessionId = null;
const seen = new Set();
const ws = new WebSocket(`${base}/api/bridge/${dorkId}`, { headers: { Authorization: `Bearer ${secret}` } });
const send = (f) => ws.send(JSON.stringify(f));
const ev = (raw) => send({ t: "event", bseq: ++bseq, raw });
const log = (...a) => console.log("[bridge-sim]", ...a);

ws.onopen = () => log("connected");
ws.onclose = (e) => { log("closed", e.code); process.exit(0); };
ws.onmessage = ({ data }) => {
  const f = JSON.parse(data);
  if (f.t === "hello") { bseq = Math.max(bseq, f.afterBridgeSeq); log("hello, numbering from", bseq + 1); }
  if (f.t === "configure") {
    log("configure: repo", f.repo.fullName, "branch", f.repo.branch, "resume", f.resumeSessionId, "env keys", Object.keys(f.env).join(","));
    sessionId = f.resumeSessionId ?? `sim-session-${Date.now()}`;
    ev({ type: "system", subtype: "init", session_id: sessionId });
    send({ t: "ready" });
  }
  if (f.t === "user_message") {
    send({ t: "ack", id: f.id });
    if (seen.has(f.id)) return;
    seen.add(f.id);
    log("message:", f.text);
    ev({ type: "stream_event", event: { type: "message_start", message: { id: `m${bseq}` } } });
    ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it… " } } });
    ev({ type: "assistant", message: { id: `m${bseq}`, content: [{ type: "text", text: `Done: ${f.text}` }, { type: "tool_use", id: `t${bseq}`, name: "Bash", input: { command: "git push" } }] } });
    ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${bseq}`, content: "ok" }] } });
    ev({ type: "result", duration_ms: 42, is_error: false });
    ev({ type: "system", subtype: "session_state_changed", state: "idle" });
  }
  if (f.t === "flush") { log("flush"); send({ t: "flushed" }); }
  if (f.t === "interrupt") log("interrupt");
  if (f.t === "gh_token") log("gh token refreshed");
};
