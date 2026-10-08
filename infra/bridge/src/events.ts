import type { FromBridge } from "@dorks/shared";
import type { Outbox } from "./outbox";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

const CLIP = 16 * 1024;
/** Hard cap for one event as sent; the backend rejects a single event over 256 KB (`event_too_large`) and a rejected event blocks the stream. */
export const MAX_EVENT_BYTES = 200 * 1024;
const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clipDeep = (v: unknown, n = CLIP): unknown => {
  if (typeof v === "string") return clipTo(v, n);
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, n));
  const o = obj(v);
  return o ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, clipDeep(x, n)])) : v;
};
const size = (v: unknown) => JSON.stringify(v).length;

/** Shrinks an oversized event: clip every string harder until it fits, finally a stub. Assistant text is only touched past the cap. */
function capSize(m: Json): Json {
  if (size(m) <= MAX_EVENT_BYTES) return m;
  for (const n of [64 * 1024, 16 * 1024, 4 * 1024, 1024]) {
    const c = clipDeep(m, n) as Json;
    if (size(c) <= MAX_EVENT_BYTES) return c;
  }
  return { type: m.type, truncated: true };
}

const isTextDelta = (raw: Json) => {
  const e = obj(raw.event);
  return raw.type === "stream_event" && e?.type === "content_block_delta" && obj(e.delta)?.type === "text_delta" && typeof obj(e.delta)?.text === "string";
};

/**
 * Decides what of the CLI's stream-json goes to the backend. The server-side normalizer (apps/convex/core/normalize.ts) only reads:
 * system init/session_state_changed, stream message_start + text deltas, assistant, user (tool_result), result, rate_limit_event.
 * Everything else (hook/status/api_retry chatter, thinking and input_json deltas, content_block_start/stop...) is dropped here:
 * it would cost a mutation arg + a bseq for nothing. Returns null to drop.
 */
export function prepare(raw: unknown): Json | null {
  const m = obj(raw);
  if (!m) return null;
  switch (m.type) {
    case "system":
      // init carries cwd, tools, mcp servers, env-derived info: send only what the backend uses.
      if (m.subtype === "init") return { type: "system", subtype: "init", session_id: m.session_id };
      if (m.subtype === "session_state_changed") return { type: "system", subtype: "session_state_changed", state: m.state };
      return null;
    case "stream_event": {
      const e = obj(m.event);
      if (e?.type === "message_start") return { type: "stream_event", event: { type: "message_start", message: { id: obj(e.message)?.id } } };
      return isTextDelta(m) ? m : null;
    }
    case "assistant":
    case "user": {
      // Tool inputs/results can be huge and the backend previews a few KB: clip those. Text is kept whole; thinking is unused.
      const msg = obj(m.message);
      // `tool_use_result` is the tool's full structured output (whole files, full stdout): the backend never reads it.
      const { tool_use_result: _drop, ...rest } = m;
      if (!Array.isArray(msg?.content)) return capSize(rest);
      const content = (msg.content as unknown[])
        .filter((b) => obj(b)?.type !== "thinking" && obj(b)?.type !== "redacted_thinking")
        .map((b) => {
          const blk = obj(b);
          return blk?.type === "tool_use" || blk?.type === "tool_result" ? (clipDeep(blk) as Json) : b;
        });
      return capSize({ ...rest, message: { ...msg, content } });
    }
    case "result":
      return { type: "result", subtype: m.subtype, is_error: m.is_error, duration_ms: m.duration_ms, result: typeof m.result === "string" ? clipTo(m.result, CLIP) : undefined, session_id: m.session_id };
    case "rate_limit_event":
      return capSize(m);
    default:
      return null;
  }
}

/**
 * Raw CLI lines in, numbered frames out. Consecutive text deltas coalesce into one event (flushed every `deltaBatchMs` or when
 * anything else arrives, so order is preserved). bseq is assigned at emit time and continues from the backend's afterBridgeSeq.
 */
export class EventPipeline {
  private seq = 0;
  private delta: { raw: Json; text: string; key: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private outbox: Outbox, private deltaBatchMs: number) {}

  /** Last assigned bseq. */
  get lastSeq() {
    return this.seq;
  }

  /** Continue numbering from the backend's stored seq (a fresh box restarts at 0). Never moves backwards. */
  continueFrom(afterBridgeSeq: number) {
    this.seq = Math.max(this.seq, afterBridgeSeq);
  }

  /** Renumbering after the backend's expected seq fell outside the replay window. */
  setSeq(n: number) {
    this.seq = n;
  }

  ingest(raw: unknown) {
    const m = prepare(raw);
    if (!m) return;
    if (isTextDelta(m)) {
      const e = obj(m.event)!;
      const key = `${String(m.parent_tool_use_id ?? "")}|${String(e.index ?? "")}`;
      const text = obj(e.delta)!.text as string;
      if (this.delta && this.delta.key !== key) this.flushDelta();
      if (this.delta) this.delta.text += text;
      else this.delta = { raw: m, text, key };
      if (this.delta.text.length > 64 * 1024) this.flushDelta(true); // keep any single event far below the backend's cap
      else this.timer ??= setTimeout(() => this.flushDelta(true), this.deltaBatchMs);
      return;
    }
    this.flushDelta();
    this.emit(m);
    this.outbox.kick();
  }

  /** Control frames keep their place in the stream: pending text goes out first. */
  control(frame: Exclude<FromBridge, { t: "event" }>, immediate = false) {
    this.flushDelta();
    this.outbox.push(frame);
    if (immediate) this.outbox.flushNow();
  }

  /** Emit any buffered text now. */
  flushDelta(kick = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const d = this.delta;
    if (!d) return;
    this.delta = null;
    const e = obj(d.raw.event)!;
    this.emit({ ...d.raw, event: { ...e, delta: { ...obj(e.delta)!, text: d.text } } });
    if (kick) this.outbox.kick();
  }

  private emit(raw: Json) {
    this.outbox.push({ t: "event", bseq: ++this.seq, raw });
  }
}
