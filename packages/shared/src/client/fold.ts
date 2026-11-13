import type { DorkState, ClientEvent, TurnOutcome } from "../events";

export type Block =
  /** `at`: when it was sent (ms since epoch). */
  | { kind: "user"; id: string; text: string; at?: number }
  /** `final`: the server named this message the turn's final answer (`turn_complete.finalMessageId`). `at`: when it completed. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; final?: boolean; at?: number }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; preview?: string; input?: Record<string, unknown> }
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

type EventOf<T extends ClientEvent["type"]> = Extract<ClientEvent, { type: T }>;
/** Applies one event to `v`, a fresh copy of the view (its `blocks` array is already copied, so handlers may push and assign). */
type Handlers = { [T in ClientEvent["type"]]?: (v: DorkView, e: EventOf<T>) => void };

const notice = (v: DorkView, e: ClientEvent, level: "info" | "error", text: string) => v.blocks.push({ kind: "notice", id: `n${e.seq}`, level, text });
const findAssistant = (v: DorkView, id: string) => v.blocks.findIndex((b) => b.kind === "assistant" && b.id === id);

const HANDLERS: Handlers = {
  user_message(v, e) {
    v.blocks.push({ kind: "user", id: `u${e.seq}`, text: e.text, at: e.ts });
    v.lastOutcome = null;
  },
  assistant_delta(v, e) {
    const i = findAssistant(v, e.messageId);
    if (i < 0) v.blocks.push({ kind: "assistant", id: e.messageId, text: e.text, streaming: true, at: e.ts });
    else {
      const b = v.blocks[i] as Extract<Block, { kind: "assistant" }>;
      v.blocks[i] = { ...b, text: b.text + e.text };
    }
  },
  assistant_message(v, e) {
    const i = findAssistant(v, e.messageId);
    const done: Block = { kind: "assistant", id: e.messageId, text: e.text, streaming: false, at: e.ts };
    if (i < 0) v.blocks.push(done);
    else v.blocks[i] = done; // the complete message replaces streamed partials
  },
  tool_use(v, e) {
    v.blocks.push({ kind: "tool", id: e.toolId, name: e.name, summary: e.summary, status: "running", ...(e.input ? { input: e.input } : {}) });
  },
  tool_result(v, e) {
    const i = v.blocks.findIndex((b) => b.kind === "tool" && b.id === e.toolId);
    if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "tool" }>), status: e.ok ? "ok" : "error", preview: e.preview };
  },
  status(v, e) {
    v.state = e.state;
  },
  turn_complete(v, e) {
    v.blocks = v.blocks.map((b) => (b.kind === "assistant" && (b.streaming || b.id === e.finalMessageId) ? { ...b, streaming: false, ...(b.id === e.finalMessageId ? { final: true } : {}) } : b));
    v.blocks.push({ kind: "turn", id: `t${e.seq}`, outcome: e.outcome ?? null, finalId: e.finalMessageId, durationMs: e.durationMs, at: e.ts });
    v.lastOutcome = e.outcome ?? null;
  },
  pr_opened(v, e) {
    v.prUrl = e.url;
    notice(v, e, "info", `PR opened: ${e.url}`);
  },
  pr_merged(v, e) {
    v.prUrl = e.url;
    notice(v, e, "info", `PR merged: ${e.url}`);
  },
  notify(v, e) {
    notice(v, e, "info", e.text);
  },
  subscription(v, e) {
    notice(v, e, e.status === "stalled" ? "error" : "info", `${e.repo}#${e.number}: ${e.status}${e.reason ? ` (${e.reason})` : ""}`);
  },
  build_draft(v, e) {
    v.blocks.push({ kind: "build", id: `b${e.seq}`, draftId: e.draftId, buildId: e.buildId, buildName: e.buildName, note: e.note, approved: null });
  },
  build_decision(v, e) {
    // A session can submit the same draft again after a decision: the decision belongs to the latest card still waiting.
    let i = -1;
    for (let k = v.blocks.length - 1; k >= 0 && i < 0; k--) {
      const b = v.blocks[k];
      if (b.kind === "build" && b.draftId === e.draftId && b.approved === null) i = k;
    }
    if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "build" }>), approved: e.approved, reason: e.reason };
    else notice(v, e, "info", `${e.approved ? "Approved" : "Rejected"} the machine draft for ${e.buildName}${e.reason ? `: ${e.reason}` : ""}`);
  },
  rate_limited(v, e) {
    v.rateLimitedUntil = e.resetsAt ?? null;
    notice(v, e, "error", e.resetsAt ? `Rate limited until ${new Date(e.resetsAt).toISOString()}` : "Rate limited");
  },
  agent_exited(v, e) {
    notice(v, e, "error", e.message);
  },
  error(v, e) {
    notice(v, e, "error", e.message);
  },
};

/** Pure + idempotent: events at or below lastSeq are ignored, so replays can never duplicate output. */
export function fold(view: DorkView, e: ClientEvent): DorkView {
  if (e.seq <= view.lastSeq) return view;
  const v: DorkView = { ...view, lastSeq: e.seq, blocks: [...view.blocks] };
  const handle = HANDLERS[e.type] as ((v: DorkView, e: ClientEvent) => void) | undefined;
  handle?.(v, e);
  return v;
}
