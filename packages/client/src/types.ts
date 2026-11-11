import type { AgentModelChoice, BuildRepo, ClientEvent, CommentPolicy, DorkState, MachineType, RunView } from "@dorks/shared";

export type { BuildView, BuildVarView, DraftView, RunView, BuildRepo, MachineType } from "@dorks/shared";

export type Provider = "claude" | "codex";

/** The client-visible dork row. Box ids, session ids and secrets are never returned by the server. */
export interface Dork {
  id: string;
  title: string;
  repo: string;
  branch: string;
  provider: Provider;
  state: DorkState;
  archived: boolean;
  preview?: string;
  /** Dev servers the agent showed (its `preview_show` tool), oldest first; absent on older servers. */
  previews?: { port: number; url: string; title?: string }[];
  /** Screenshots the agent shared (its `screenshot_share` tool), oldest first; load one with `client.imageUrl(id)`. */
  images?: { id: string; caption?: string; width?: number; height?: number; createdAt: number }[];
  prUrl?: string;
  codexModel?: { model: string; effort: string };
  codexModelChoices?: { model: string; efforts: string[] }[];
  /** Claude: the model and effort chosen for this session (absent: the agent's default). */
  model?: string;
  effort?: string;
  /** What the agent confirmed it runs: the model from its init event (a full id), the effort it was started with. */
  agentModel?: string;
  agentEffort?: string;
  /** The models the agent offers this account, as it last reported them. */
  modelChoices?: AgentModelChoice[];
  /** The build its machine starts from (docs/builds.md); null: the base snapshot. Absent on older servers. */
  buildId?: string | null;
  lastActivityAt: number;
  createdAt: number;
}

export interface CreateDorkInput {
  /** owner/name; optional only for a setup session. */
  repo?: string;
  /** The build to start from (default: the default build, else the base snapshot). */
  buildId?: string;
  /** A machine-setup session for `buildId`: no repo needed, and the build needs no image yet. */
  setup?: boolean;
  message: string;
  title?: string;
  provider?: Provider;
  /** Claude: one of `Settings.claudeModels` (omit for the default), and one of its efforts. */
  model?: string;
  effort?: string;
}

/** Plain values and booleans only: the server never returns a secret. */
export interface Settings {
  claudeToken: boolean;
  boatKey: boolean;
  github: { configured: boolean; login?: string | null };
  boatOrg: string | null;
  boatEnvironment: string | null;
  baseSnapshotId: string | null;
  sleepMinutes: number;
  commentPolicy: CommentPolicy;
  publicUrlConfigured: boolean;
  /** `boat` or `sim`; absent on older servers. */
  boxProvider?: string;
  /** The models a Claude agent last reported (empty before any session started); what a new session can choose from. */
  claudeModels?: AgentModelChoice[];
  /** The build new sessions start on; null: the base snapshot. */
  defaultBuildId?: string | null;
}

export interface BuildInput {
  name?: string;
  machineType?: MachineType;
  setupScript?: string;
  repos?: BuildRepo[];
}

export interface BuildVarInput {
  /** Omit to keep the stored value (to change a flag only). */
  value?: string;
  secret?: boolean;
  buildTime?: boolean;
}

export interface RunLog {
  text: string;
  /** Byte offset to ask from next. */
  next: number;
  done: boolean;
  run: RunView;
}

/** Any subset. Token fields are write-only; an empty string clears one. */
export interface SettingsPatch {
  boatKey?: string;
  boatOrg?: string;
  claudeToken?: string;
  githubToken?: string;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  sleepMinutes?: number;
  commentPolicy?: CommentPolicy;
}

/** `POST /api/boat/check`: whether Boat accepts a key (and organization) before anything is saved. */
export interface BoatCheck {
  status: "ok" | "invalid" | "needs_org" | "credit_required" | "unreachable";
  /** Plain words for the user. */
  message: string;
}

/** The "Prepare Boat" build of the base snapshot (`GET /api/snapshot`, docs/architecture.md "Base snapshot"). */
export interface SnapshotStatus {
  /** none: never built. building: running. failed: the last attempt failed (the previous good snapshot, if any, is still in use). ready: built. */
  state: "none" | "building" | "ready" | "failed";
  /** The saved snapshot this app last built, or null. */
  snapshot: string | null;
  /** True when sandboxes start from `snapshot` (it is `settings.baseSnapshotId`); false when the name was entered by hand. */
  managed: boolean;
  /** Built from an older bridge or installer than this app carries: rebuild to update. */
  stale: boolean;
  step: "prepare" | "create" | "start" | "upload" | "install" | "save" | "finish" | null;
  stepIndex: number;
  stepCount: number;
  /** What the running step is doing, in words. */
  message: string | null;
  /** Why the last attempt failed, written for the user. */
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  builtBundleId: string | null;
  currentBundleId: string | null;
  canBuild: boolean;
  cannotBuildReason: string | null;
}

export interface EventsPage {
  events: ClientEvent[];
  hasMore: boolean;
}

/** One message of the `/api/live` stream. They are invalidations, not payloads: refetch what they name. */
export type LiveMessage =
  | { t: "hello"; now: number }
  | { t: "dorks" }
  | { t: "dork"; dorkId: string }
  | { t: "events"; dorkId: string; seq: number }
  | { t: "subscriptions"; dorkId: string }
  | { t: "settings" }
  | { t: "snapshot" }
  | { t: "builds" }
  | { t: "build"; buildId: string };

export interface PrRefInput {
  repo: string;
  number: number;
}

/** `GET /api/usage`: a part is missing when its credential is not set or its source failed. `used` is 0..1, times are epoch ms. */
export interface UsageWindow {
  used: number;
  resetsAt?: number;
}
export interface Usage {
  claude?: { session: UsageWindow; weekly: UsageWindow };
  cloud?: { usedHours: number; includedHours: number; periodEnd?: number };
}
