import { agentEventRaw, errorEvent, type AgentEvent, type ClientEventBody } from "@dorks/shared";

// Bridge event payloads -> client events. Two dialects arrive here: raw Claude Code stream-json (shapes per the documented protocol,
// code.claude.com headless / Agent SDK types), and the harness-neutral agent events (packages/shared/src/agent.ts) that every other
// harness's adapter in the bridge emits.
export type Normalized =
  | { kind: "event"; body: ClientEventBody }
  | { kind: "session"; sessionId: string }
  | { kind: "idle" };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const PREVIEW_MAX = 2048;

export function summarizeTool(input: unknown): string {
  const i = obj(input) ?? {};
  const pick = str(i.command) ?? str(i.file_path) ?? str(i.filePath) ?? str(i.path) ?? str(i.pattern) ?? str(i.url) ?? str(i.description);
  return clip(pick ?? JSON.stringify(i), 200);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => str(obj(b)?.text) ?? "").join("");
  return "";
}

/** Stateful (tracks the in-flight message id for deltas); create one per dork/agent process. */
export function createNormalizer() {
  let streamingMessageId = "";

  return function normalize(raw: unknown): Normalized[] {
    const m = obj(raw);
    if (!m) return [];
    const neutral = agentEventRaw.safeParse(m);
    if (neutral.success) return fromAgentEvent(neutral.data.event);
    const out: Normalized[] = [];
    const ev = (body: ClientEventBody) => out.push({ kind: "event", body });

    switch (m.type) {
      case "system": {
        if (m.subtype === "init" && str(m.session_id)) out.push({ kind: "session", sessionId: m.session_id as string });
        if (m.subtype === "session_state_changed" && m.state === "idle") out.push({ kind: "idle" });
        break;
      }
      case "stream_event": {
        const e = obj(m.event);
        if (e?.type === "message_start") streamingMessageId = str(obj(e.message)?.id) ?? "";
        if (e?.type === "content_block_delta" && !m.parent_tool_use_id) {
          const d = obj(e.delta);
          if (d?.type === "text_delta" && str(d.text)) ev({ type: "assistant_delta", messageId: streamingMessageId, text: d.text as string });
        }
        break;
      }
      case "assistant": {
        const msg = obj(m.message);
        const messageId = str(msg?.id) ?? "";
        for (const b of Array.isArray(msg?.content) ? (msg.content as unknown[]) : []) {
          const block = obj(b);
          if (block?.type === "text" && str(block.text) && !m.parent_tool_use_id) ev({ type: "assistant_message", messageId, text: block.text as string });
          if (block?.type === "tool_use") ev({ type: "tool_use", toolId: String(block.id), name: String(block.name), summary: summarizeTool(block.input) });
        }
        break;
      }
      case "user": {
        const content = obj(m.message)?.content;
        for (const b of Array.isArray(content) ? (content as unknown[]) : []) {
          const block = obj(b);
          if (block?.type === "tool_result") {
            ev({ type: "tool_result", toolId: String(block.tool_use_id), ok: block.is_error !== true, preview: clip(toolResultText(block.content), PREVIEW_MAX) });
          }
        }
        break;
      }
      case "result": {
        ev({ type: "turn_complete", durationMs: typeof m.duration_ms === "number" ? m.duration_ms : 0 });
        if (m.is_error === true) ev(errorEvent({ code: "turn_failed", message: clip(str(m.result) ?? str(m.subtype) ?? "turn failed", 500) }));
        break;
      }
      case "rate_limit_event": {
        const info = obj(m.rate_limit_info);
        if (info?.status === "rejected") {
          const r = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
          ev({ type: "rate_limited", resetsAt: r === undefined ? undefined : r < 1e12 ? r * 1000 : r }); // epoch seconds -> ms
        }
        break;
      }
    }
    return out;
  };
}

/** A neutral agent event carries its own message id, so unlike Claude's stream it needs no state carried between batches. */
function fromAgentEvent(e: AgentEvent): Normalized[] {
  const ev = (body: ClientEventBody): Normalized => ({ kind: "event", body });
  switch (e.type) {
    case "session":
      return [{ kind: "session", sessionId: e.sessionId }];
    case "idle":
      return [{ kind: "idle" }];
    case "text_delta":
      return e.text ? [ev({ type: "assistant_delta", messageId: e.messageId, text: e.text })] : [];
    case "text":
      return e.text ? [ev({ type: "assistant_message", messageId: e.messageId, text: e.text })] : [];
    case "tool_use":
      return [ev({ type: "tool_use", toolId: e.toolId, name: e.name, summary: summarizeTool(e.input) })];
    case "tool_result":
      return [ev({ type: "tool_result", toolId: e.toolId, ok: e.ok, preview: clip(e.output, PREVIEW_MAX) })];
    case "turn_complete": {
      const done = ev({ type: "turn_complete", durationMs: e.durationMs });
      return e.error === undefined ? [done] : [done, ev(errorEvent({ code: "turn_failed", message: clip(e.error || "turn failed", 500) }))];
    }
    case "rate_limited":
      return [ev({ type: "rate_limited", resetsAt: e.resetsAt })];
  }
}
