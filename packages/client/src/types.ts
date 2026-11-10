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
  | { t: "settings" };

export interface PrRefInput {
  repo: string;
  number: number;
}
