import type { DorkState, ClientEvent, TurnOutcome } from "../events";

export type Block =
  | { kind: "user"; id: string; text: string }
  /** `final`: the server named this message the turn's final answer (`turn_complete.finalMessageId`). */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; final?: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; preview?: string }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string }
  /** The agent submitted a draft of its machine for approval (docs/builds.md). `approved` is null until the owner decides. */
  | { kind: "build"; id: string; draftId: string; buildId: string | null; buildName: string; note?: string; approved: boolean | null; reason?: string }
  /**
   * The end of an agent turn: everything since the previous turn (or user message) belongs to it. `outcome` is null for turns stored
   * before the server stamped outcomes and final answers; render those as they always were.
   */
  | { kind: "turn"; id: string; outcome: TurnOutcome | null; finalId?: string; durationMs: number; /** When it ended (ms since epoch). */ at: number };

export interface DorkView {
  lastSeq: number;
  state: DorkState | null;
  blocks: Block[];
  prUrl: string | null;
  rateLimitedUntil: number | null;
  /** How the latest turn ended, or null before the first one (or for turns stored before outcomes existed). */
  lastOutcome: TurnOutcome | null;
}

export const emptyView = (): DorkView => ({ lastSeq: 0, state: null, blocks: [], prUrl: null, rateLimitedUntil: null, lastOutcome: null });

/** Pure + idempotent: events at or below lastSeq are ignored, so replays can never duplicate output. */
export function fold(view: DorkView, e: ClientEvent): DorkView {
  if (e.seq <= view.lastSeq) return view;
  const v: DorkView = { ...view, lastSeq: e.seq, blocks: [...view.blocks] };
  const notice = (level: "info" | "error", text: string) => v.blocks.push({ kind: "notice", id: `n${e.seq}`, level, text });
  const find = (pred: (b: Block) => boolean) => v.blocks.findIndex(pred);

  switch (e.type) {
    case "user_message":
      v.blocks.push({ kind: "user", id: `u${e.seq}`, text: e.text });
      v.lastOutcome = null;
      break;
    case "assistant_delta": {
      const i = find((b) => b.kind === "assistant" && b.id === e.messageId);
      if (i < 0) v.blocks.push({ kind: "assistant", id: e.messageId, text: e.text, streaming: true });
      else {
        const b = v.blocks[i] as Extract<Block, { kind: "assistant" }>;
        v.blocks[i] = { ...b, text: b.text + e.text };
      }
      break;
    }
    case "assistant_message": {
      const i = find((b) => b.kind === "assistant" && b.id === e.messageId);
      const done: Block = { kind: "assistant", id: e.messageId, text: e.text, streaming: false };
      if (i < 0) v.blocks.push(done);
      else v.blocks[i] = done; // the complete message replaces streamed partials
      break;
    }
    case "tool_use":
      v.blocks.push({ kind: "tool", id: e.toolId, name: e.name, summary: e.summary, status: "running" });
      break;
    case "tool_result": {
      const i = find((b) => b.kind === "tool" && b.id === e.toolId);
      if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "tool" }>), status: e.ok ? "ok" : "error", preview: e.preview };
      break;
    }
    case "status":
      v.state = e.state;
      break;
    case "turn_complete":
      v.blocks = v.blocks.map((b) =>
        b.kind === "assistant" && (b.streaming || b.id === e.finalMessageId) ? { ...b, streaming: false, ...(b.id === e.finalMessageId ? { final: true } : {}) } : b,
      );
      v.blocks.push({ kind: "turn", id: `t${e.seq}`, outcome: e.outcome ?? null, finalId: e.finalMessageId, durationMs: e.durationMs, at: e.ts });
      v.lastOutcome = e.outcome ?? null;
      break;
    case "pr_opened":
    case "pr_merged":
      v.prUrl = e.url;
      notice("info", `${e.type === "pr_opened" ? "PR opened" : "PR merged"}: ${e.url}`);
      break;
    case "notify":
      notice("info", e.text);
      break;
    case "subscription":
      notice(e.status === "stalled" ? "error" : "info", `${e.repo}#${e.number}: ${e.status}${e.reason ? ` (${e.reason})` : ""}`);
      break;
    case "build_draft":
      v.blocks.push({ kind: "build", id: `b${e.seq}`, draftId: e.draftId, buildId: e.buildId, buildName: e.buildName, note: e.note, approved: null });
      break;
    case "build_decision": {
      const i = find((b) => b.kind === "build" && b.draftId === e.draftId);
      if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "build" }>), approved: e.approved, reason: e.reason };
      else notice("info", `${e.approved ? "Approved" : "Rejected"} the machine draft for ${e.buildName}${e.reason ? `: ${e.reason}` : ""}`);
      break;
    }
    case "rate_limited":
      v.rateLimitedUntil = e.resetsAt ?? null;
      notice("error", e.resetsAt ? `Rate limited until ${new Date(e.resetsAt).toISOString()}` : "Rate limited");
      break;
    case "agent_exited":
    case "error":
      notice("error", e.message);
      break;
  }
  return v;
}
