import type { ClientEvent, DorkState } from "@dorks/shared";
import type { Db, Row } from "./db";
import { bool, json } from "./db";

// Typed readers over the schema (migrations.ts). Columns are snake_case in SQL and camelCase here; NULL becomes undefined.

export type Provider = "claude" | "codex";

export interface Pause {
  gen: number;
  phase: "flushing" | "pausing" | "cancelled";
  since?: number;
  flushCid?: string;
}

export interface DorkRow {
  id: string;
  title: string;
  repo: string;
  branch: string;
  provider: Provider;
  state: DorkState;
  archived: boolean;
  boxId?: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  codexModel?: { model: string; effort: string };
  codexModelChoices?: { model: string; efforts: string[] }[];
  preview?: string;
  prUrl?: string;
  deleting: boolean;
  lastActivityAt: number;
  createdAt: number;
}

export interface Runtime {
  dorkId: string;
  bridgeSeq: number;
  streamMsgId: string;
  sleepMinutes: number;
  bridgeSeenAt: number;
  bridgeLost: boolean;
  opGen: number;
  pause?: Pause;
  pauseRetries: number;
}

export type CommandKind = "user_message" | "notify" | "configure" | "interrupt" | "flush";

export interface CommandRow {
  id: number;
  dorkId: string;
  kind: CommandKind;
  cid: string;
  text?: string;
  meta?: { kinds: string[]; prs: { repo: string; number: number }[] };
  released: boolean;
  acked: boolean;
}

const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const dorkOf = (r: Row): DorkRow => ({
  id: r.id as string, title: r.title as string, repo: r.repo as string, branch: r.branch as string,
  provider: r.provider as Provider, state: r.state as DorkState, archived: bool(r.archived),
  boxId: u(r.box_id as string | null), claudeSessionId: u(r.claude_session_id as string | null), codexThreadId: u(r.codex_thread_id as string | null),
  codexModel: json(r.codex_model), codexModelChoices: json(r.codex_model_choices),
  preview: u(r.preview as string | null), prUrl: u(r.pr_url as string | null), deleting: bool(r.deleting),
  lastActivityAt: r.last_activity_at as number, createdAt: r.created_at as number,
});

export const getDork = (db: Db, id: string): DorkRow | undefined => {
  const r = db.get("SELECT * FROM dorks WHERE id = ?", id);
  return r ? dorkOf(r) : undefined;
};

export const runtimeOf = (db: Db, dorkId: string): Runtime => {
  const r = db.get("SELECT * FROM dork_runtime WHERE dork_id = ?", dorkId);
  if (!r) throw new Error("dork runtime missing");
  return {
    dorkId, bridgeSeq: r.bridge_seq as number, streamMsgId: r.stream_msg_id as string, sleepMinutes: r.sleep_minutes as number,
    bridgeSeenAt: r.bridge_seen_at as number, bridgeLost: bool(r.bridge_lost), opGen: r.op_gen as number,
    pause: json(r.pause), pauseRetries: r.pause_retries as number,
  };
};

export const commandOf = (r: Row): CommandRow => ({
  id: r.id as number, dorkId: r.dork_id as string, kind: r.kind as CommandKind, cid: r.cid as string, text: u(r.text as string | null),
  meta: json(r.meta), released: bool(r.released), acked: bool(r.acked),
});

export const openCommands = (db: Db, dorkId: string): CommandRow[] =>
  db.all("SELECT * FROM commands WHERE dork_id = ? AND acked = 0 ORDER BY id", dorkId).map(commandOf);

/** The wire shape of a dork for the UI: no box id, session ids or other internals. */
export const dorkView = (d: DorkRow) => ({
  id: d.id, title: d.title, repo: d.repo, branch: d.branch, provider: d.provider, state: d.state, archived: d.archived,
  preview: d.preview, prUrl: d.prUrl, codexModel: d.codexModel, codexModelChoices: d.codexModelChoices,
  lastActivityAt: d.lastActivityAt, createdAt: d.createdAt,
});
export type DorkView = ReturnType<typeof dorkView>;

export const eventOf = (r: Row): ClientEvent =>
  ({ ...(JSON.parse(r.body as string) as object), seq: r.seq as number, dorkId: r.dork_id as string, ts: r.ts as number }) as ClientEvent;
