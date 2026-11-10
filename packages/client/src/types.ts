import type { ClientEvent, CommentPolicy, DorkState } from "@dorks/shared";

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
  prUrl?: string;
  codexModel?: string;
  codexModelChoices?: { model: string; efforts: string[] }[];
  lastActivityAt: number;
  createdAt: number;
}

export interface CreateDorkInput {
  repo: string;
  message: string;
  title?: string;
  provider?: Provider;
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
  | { t: "snapshot" };

export interface PrRefInput {
  repo: string;
  number: number;
}
