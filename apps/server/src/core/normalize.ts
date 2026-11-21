import { errorEvent, type ClientEventBody } from "@dorks/shared";

// Raw Claude Code stream-json -> client events. Shapes follow the documented protocol
// (code.claude.com headless / Agent SDK types); verify against a real stream in spike S1.
export type Normalized =
  | { kind: "event"; body: ClientEventBody }
  /** `model`: the model the agent reports it runs (Claude's `system/init`), the confirmation of what was asked for. */
  | { kind: "session"; sessionId: string; model?: string }
  | { kind: "idle" };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const PREVIEW_MAX = 2048;
/** Each string in a tool call's input: enough for an edit's diff or a written file, small enough for the event log. */
export const INPUT_MAX = 8192;

const clipDeep = (v: unknown): unknown => {
  if (typeof v === "string") return clip(v, INPUT_MAX);
  if (Array.isArray(v)) return v.map(clipDeep);
  const o = obj(v);
  return o ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, clipDeep(x)])) : v;
};

export function summarizeTool(input: unknown): string {
  const i = obj(input) ?? {};
  const pick = str(i.command) ?? str(i.file_path) ?? str(i.path) ?? str(i.pattern) ?? str(i.url) ?? str(i.description);
  return clip(pick ?? JSON.stringify(i), 200);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => str(obj(b)?.text) ?? "").join("");
  return "";
}

const event = (body: ClientEventBody): Normalized => ({ kind: "event", body });
const blocks = (content: unknown): Json[] => (Array.isArray(content) ? content.map(obj).filter((b): b is Json => !!b) : []);

function fromSystem(m: Json): Normalized[] {
  const out: Normalized[] = [];
  if (m.subtype === "init" && str(m.session_id)) out.push({ kind: "session", sessionId: m.session_id as string, ...(str(m.model) ? { model: clip(m.model as string, 64) } : {}) });
  if (m.subtype === "session_state_changed" && m.state === "idle") out.push({ kind: "idle" });
  return out;
}

function fromAssistant(m: Json): Normalized[] {
  const msg = obj(m.message);
  const messageId = str(msg?.id) ?? "";
  const out: Normalized[] = [];
  for (const block of blocks(msg?.content)) {
    if (block.type === "text" && str(block.text) && !m.parent_tool_use_id) out.push(event({ type: "assistant_message", messageId, text: block.text as string }));
    if (block.type === "tool_use")
      out.push(
        event({ type: "tool_use", toolId: String(block.id), name: String(block.name), summary: summarizeTool(block.input), ...(obj(block.input) ? { input: clipDeep(block.input) as Json } : {}) }),
      );
  }
  return out;
}

function fromUser(m: Json): Normalized[] {
  return blocks(obj(m.message)?.content)
    .filter((block) => block.type === "tool_result")
    .map((block) => event({ type: "tool_result", toolId: String(block.tool_use_id), ok: block.is_error !== true, preview: clip(toolResultText(block.content), PREVIEW_MAX) }));
}

function fromResult(m: Json): Normalized[] {
  // `finalMessageId` and a `stopped` outcome are stamped by the caller, which knows the turn (services/bridge.ts).
  const out = [event({ type: "turn_complete", durationMs: typeof m.duration_ms === "number" ? m.duration_ms : 0, outcome: m.is_error === true ? "failed" : "done" })];
  if (m.is_error === true) out.push(event(errorEvent({ code: "turn_failed", message: clip(str(m.result) ?? str(m.subtype) ?? "turn failed", 500) })));
  return out;
}

function fromRateLimit(m: Json): Normalized[] {
  const info = obj(m.rate_limit_info);
  if (info?.status !== "rejected") return [];
  const r = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
  return [event({ type: "rate_limited", resetsAt: r === undefined ? undefined : r < 1e12 ? r * 1000 : r })]; // epoch seconds -> ms
}

const STATELESS: Record<string, (m: Json) => Normalized[]> = {
  system: fromSystem,
  assistant: fromAssistant,
  user: fromUser,
  result: fromResult,
  rate_limit_event: fromRateLimit,
};

/** Stateful (tracks the in-flight message id for deltas); create one per dork/agent process. */
export function createNormalizer() {
  let streamingMessageId = "";

  const fromStreamEvent = (m: Json): Normalized[] => {
    const e = obj(m.event);
    if (e?.type === "message_start") streamingMessageId = str(obj(e.message)?.id) ?? "";
    if (e?.type !== "content_block_delta" || m.parent_tool_use_id) return [];
    const d = obj(e.delta);
    return d?.type === "text_delta" && str(d.text) ? [event({ type: "assistant_delta", messageId: streamingMessageId, text: d.text as string })] : [];
  };

  return function normalize(raw: unknown): Normalized[] {
    const m = obj(raw);
    if (!m) return [];
    if (m.type === "stream_event") return fromStreamEvent(m);
    const handler = typeof m.type === "string" && Object.hasOwn(STATELESS, m.type) ? STATELESS[m.type] : undefined;
    return handler ? handler(m) : [];
  };
}
