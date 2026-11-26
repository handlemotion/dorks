import type { DorkState, ClientEvent, LocalKind, TurnOutcome } from "../events";
import type { NotifyKind, PrRef } from "../autonomy";
import type { InputField } from "../inputs";
import type { ShipView } from "../ship";
import type { ChatRun } from "../builds";
import type { DraftChanges } from "../buildDiff";

/**
 * What an autonomy notice came from (docs/autonomy.md), kept so clients can label it by what happened and give it its own icon: a PR
 * event digest handed to the agent, the agent's PR opened or merged, or a PR subscription that changed.
 */
export type NoticeHook =
  | { type: "notify"; kinds: NotifyKind[]; prs: PrRef[]; text: string; /** "preview": the owner's comments on a running preview. */ source?: "preview" }
  | { type: "pr_opened" | "pr_merged"; url: string; number: number }
  | { type: "subscription"; repo: string; number: number; status: "active" | "stalled" | "ended"; reason?: string };

export type Block =
  /** `at`: when it was sent (ms since epoch). */
  | { kind: "user"; id: string; text: string; at?: number; /** Sent by a coordinator dork (docs/crew.md). */ from?: { id: string; title: string } }
  /** `final`: the server named this message the turn's final answer (`turn_complete.finalMessageId`). `at`: when it completed. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; final?: boolean; at?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      status: "running" | "ok" | "error";
      preview?: string;
      input?: Record<string, unknown>;
      /** When the call started (ms since epoch). */ at?: number;
    }
  /** `hook`: the autonomy event it came from, when it did. `at`: when it happened. */
  | { kind: "notice"; id: string; level: "info" | "error"; text: string; hook?: NoticeHook; at?: number }
  /** A crew report or note (docs/crew.md): a worker's final answer reaching its dork, or a note between them. */
  | { kind: "crew"; id: string; direction: "in" | "out"; peer: { id: string; title: string }; note: boolean; text: string; at: number }
  /** The agent submitted a draft of its machine for approval (docs/builds.md). `approved` is null until the owner decides. */
  | {
      kind: "build";
      id: string;
      draftId: string;
      buildId: string | null;
      buildName: string;
      note?: string;
      /** What the draft changes, as submitted; absent on drafts submitted before the server kept it. */
      changes?: DraftChanges;
      approved: boolean | null;
      reason?: string;
      at?: number;
    }
  /** A build run of this session (docs/builds.md): kept at the place of its first event and updated in place, like a ship. */
  | { kind: "buildRun"; id: string; run: ChatRun; at: number }
  /**
   * The agent asked to use the owner's computer (docs/local-access.md). `status` moves from `pending` to `denied` or `expired`, or to
   * `allowed` and then `done` / `failed` once the command ran or the file was read.
   */
  | {
      kind: "local";
      id: string;
      requestId: string;
      request: LocalKind;
      command?: string;
      cwd?: string;
      path?: string;
      reason: string;
      status: "pending" | "allowed" | "denied" | "expired" | "done" | "failed";
      via?: "session" | "always" | "standing" | "once" | "grant";
      exitCode?: number | null;
      preview?: string;
      truncated?: boolean;
      at: number;
    }
  /** The agent asked the owner for values it uses without reading them (docs/secure-inputs.md). Never holds a value. */
  | {
      kind: "input";
      id: string;
      requestId: string;
      title: string;
      description?: string;
      fields: InputField[];
      status: "pending" | "provided" | "dismissed" | "expired";
      /** The fields the owner filled in. */
      names?: string[];
      at: number;
    }
  /** What a merged pull request set off (docs/shipping.md): one card per ship, kept at the place of its first event and updated in place. */
  | { kind: "ship"; id: string; ship: ShipView; at: number }
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

const notice = (v: DorkView, e: ClientEvent, level: "info" | "error", text: string, hook?: NoticeHook) =>
  v.blocks.push({ kind: "notice", id: `n${e.seq}`, level, text, ...(hook ? { hook, at: e.ts } : {}) });
const findLocal = (v: DorkView, requestId: string) => v.blocks.findIndex((b) => b.kind === "local" && b.requestId === requestId);
const findAssistant = (v: DorkView, id: string) => v.blocks.findIndex((b) => b.kind === "assistant" && b.id === id);

const HANDLERS: Handlers = {
  user_message(v, e) {
    v.blocks.push({ kind: "user", id: `u${e.seq}`, text: e.text, at: e.ts, ...(e.from ? { from: e.from } : {}) });
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
    v.blocks.push({ kind: "tool", id: e.toolId, name: e.name, summary: e.summary, status: "running", at: e.ts, ...(e.input ? { input: e.input } : {}) });
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
    notice(v, e, "info", `PR opened: ${e.url}`, { type: "pr_opened", url: e.url, number: e.number });
  },
  pr_merged(v, e) {
    v.prUrl = e.url;
    notice(v, e, "info", `PR merged: ${e.url}`, { type: "pr_merged", url: e.url, number: e.number });
  },
  ship(v, e) {
    const i = v.blocks.findIndex((b) => b.kind === "ship" && b.ship.id === e.ship.id);
    if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "ship" }>), ship: e.ship };
    else v.blocks.push({ kind: "ship", id: `s${e.seq}`, ship: e.ship, at: e.ts });
  },
  notify(v, e) {
    notice(v, e, "info", e.text, { type: "notify", kinds: e.kinds, prs: e.prs, text: e.text, ...(e.source ? { source: e.source } : {}) });
  },
  crew(v, e) {
    v.blocks.push({ kind: "crew", id: `c${e.seq}`, direction: e.direction, peer: e.peer, note: e.kind === "note", text: e.text, at: e.ts });
  },
  subscription(v, e) {
    notice(v, e, e.status === "stalled" ? "error" : "info", `${e.repo}#${e.number}: ${e.status}${e.reason ? ` (${e.reason})` : ""}`, {
      type: "subscription",
      repo: e.repo,
      number: e.number,
      status: e.status,
      ...(e.reason ? { reason: e.reason } : {}),
    });
  },
  build_draft(v, e) {
    v.blocks.push({ kind: "build", id: `b${e.seq}`, draftId: e.draftId, buildId: e.buildId, buildName: e.buildName, note: e.note, changes: e.changes, approved: null, at: e.ts });
  },
  build_run(v, e) {
    const i = v.blocks.findIndex((b) => b.kind === "buildRun" && b.run.id === e.run.id);
    if (i >= 0) v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "buildRun" }>), run: e.run };
    else v.blocks.push({ kind: "buildRun", id: `r${e.seq}`, run: e.run, at: e.ts });
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
  local_request(v, e) {
    v.blocks.push({ kind: "local", id: `l${e.seq}`, requestId: e.requestId, request: e.kind, command: e.command, cwd: e.cwd, path: e.path, reason: e.reason, status: "pending", at: e.ts });
  },
  local_decision(v, e) {
    const i = findLocal(v, e.requestId);
    if (i < 0) return;
    const b = v.blocks[i] as Extract<Block, { kind: "local" }>;
    v.blocks[i] = { ...b, status: e.decision, via: e.via };
  },
  local_result(v, e) {
    const i = findLocal(v, e.requestId);
    if (i < 0) return;
    const b = v.blocks[i] as Extract<Block, { kind: "local" }>;
    v.blocks[i] = { ...b, status: e.ok ? "done" : "failed", exitCode: e.exitCode, preview: e.preview, truncated: e.truncated };
  },
  input_request(v, e) {
    v.blocks.push({ kind: "input", id: `i${e.seq}`, requestId: e.requestId, title: e.title, description: e.description, fields: e.fields, status: "pending", at: e.ts });
  },
  input_response(v, e) {
    const i = v.blocks.findIndex((b) => b.kind === "input" && b.requestId === e.requestId);
    if (i < 0) return;
    v.blocks[i] = { ...(v.blocks[i] as Extract<Block, { kind: "input" }>), status: e.status, names: e.names };
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
