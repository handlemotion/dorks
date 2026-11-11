import type { AgentModelChoice, ClientEvent, DorkState } from "@dorks/shared";
import type { Db, Row } from "./db";
import { bool, json } from "./db";

// Typed readers over the schema (migrations.ts). Columns are snake_case in SQL and camelCase here; NULL becomes undefined.

export type Provider = "claude" | "codex";
export type TitleSource = "message" | "auto" | "user";

export interface Pause {
  gen: number;
  phase: "flushing" | "pausing" | "cancelled";
  since?: number;
  flushCid?: string;
}

export interface DorkRow {
  id: string;
  title: string;
  titleSource: TitleSource;
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
  /** Claude: chosen in the UI (undefined: the CLI's default). */
  model?: string;
  effort?: string;
  /** What the agent confirmed: the model from its init event, the effort the bridge started it with. */
  agentModel?: string;
  agentEffort?: string;
  /** The models the agent offers this account, as it last reported them. */
  modelChoices?: AgentModelChoice[];
  preview?: string;
  /** Dev servers the agent showed (preview_show), oldest first. */
  previews?: Preview[];
  /** Screenshots the agent shared (screenshot_share), oldest first. */
  images?: SharedImage[];
  prUrl?: string;
  deleting: boolean;
  lastActivityAt: number;
  createdAt: number;
}

export type Preview = { port: number; url: string; title?: string };
export type SharedImage = { id: string; caption?: string; width?: number; height?: number; createdAt: number };

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
  finalMsgId: string;
  interruptRequested: boolean;
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
  id: r.id as string, title: r.title as string, titleSource: r.title_source as TitleSource, repo: r.repo as string, branch: r.branch as string,
  provider: r.provider as Provider, state: r.state as DorkState, archived: bool(r.archived),
  boxId: u(r.box_id as string | null), claudeSessionId: u(r.claude_session_id as string | null), codexThreadId: u(r.codex_thread_id as string | null),
  codexModel: json(r.codex_model), codexModelChoices: json(r.codex_model_choices),
  model: u(r.model as string | null), effort: u(r.effort as string | null), agentModel: u(r.agent_model as string | null),
  agentEffort: u(r.agent_effort as string | null), modelChoices: json(r.model_choices),
  preview: u(r.preview as string | null), previews: json(r.previews), images: json(r.images), prUrl: u(r.pr_url as string | null), deleting: bool(r.deleting),
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
    finalMsgId: (r.final_msg_id as string | null) ?? "", interruptRequested: bool(r.interrupt_requested),
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
  preview: d.preview, previews: d.previews ?? [], images: d.images ?? [], prUrl: d.prUrl, codexModel: d.codexModel, codexModelChoices: d.codexModelChoices,
  model: d.model, effort: d.effort, agentModel: d.agentModel, agentEffort: d.agentEffort, modelChoices: d.modelChoices,
  lastActivityAt: d.lastActivityAt, createdAt: d.createdAt,
});
export type DorkView = ReturnType<typeof dorkView>;

export const eventOf = (r: Row): ClientEvent =>
  ({ ...(JSON.parse(r.body as string) as object), seq: r.seq as number, dorkId: r.dork_id as string, ts: r.ts as number }) as ClientEvent;
