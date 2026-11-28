import type {
  AgentCommand,
  PlanId,
  AgentModelChoice,
  BuildRepo,
  BuildService,
  ClientEvent,
  CommentPolicy,
  DorkLocation,
  DorkMode,
  DorkState,
  LocalAvailability,
  MachineType,
  RunView,
  SessionPr,
} from "@dorks/shared";

export type { WorkspaceFile, WorkspaceGitStatus, WorkspaceRoot, WorkspaceTree } from "@dorks/shared";
export type { MergeMethod, MergeableState, PullRequestSection, PullRequestView, PullRequestFile, PullRequestComment, PullRequestChecks, PullRequestCheck, PullRequestPerson } from "@dorks/shared";
export type { AutomationInput, AutomationRunView, AutomationTrigger, AutomationView, GithubEvent, GithubTrigger, ScheduleEvery, ScheduleTrigger, SentryEvent, SentryTrigger } from "@dorks/shared";
export type {
  BuildView,
  BuildVarView,
  DraftView,
  RunView,
  BuildRepo,
  BuildService,
  MachineType,
  McpServerView,
  McpServerInput,
  ComposioStatus,
  SkillView,
  SkillCandidate,
  LocalSkill,
  SkillResolution,
} from "@dorks/shared";

export type Provider = "claude" | "codex" | "opencode" | "antigravity";

/** A message waiting for the agent's current turn to end (`POST /api/dorks/:id/queue`). */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  /** The teammate who queued it on a team server (docs/cloud.md); absent for the local owner. */
  by?: Person;
}

/** A teammate, as the server names them in attribution and presence (docs/cloud.md). */
export interface Person {
  id: string;
  name: string;
}

/** Who this client is to the server (`GET /api/me`): the local owner, the single-owner phone, or a member of the server's team. */
export interface Me {
  kind: "local" | "phone" | "member";
  /** The member's dorks-cloud user id; null for the local owner. */
  id: string | null;
  name: string | null;
  email: string | null;
  role: "owner" | "admin" | "member";
  org: string | null;
  plan: PlanId | null;
  /** The organization this server belongs to; null before it is part of one. */
  serverOrg: string | null;
}

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
  /** The PR's state as the server's poller last saw it; absent before its first look and on older servers. */
  prState?: "open" | "merged" | "closed";
  /** Every pull request of the session the UI lists, oldest first, with the checks a merge set off while they run. Absent when none, and on older servers. */
  prs?: SessionPr[];
  /** True when the dork is waiting on the owner (a computer-access prompt, build approval, or other request). Absent on older servers. */
  needsAttention?: boolean;
  /** The agent finished a turn the owner has not read yet (on any device); `markRead` clears it. Absent on older servers. */
  unread?: boolean;
  /** Messages the owner queued for when the current turn ends, oldest first. Only on a single dork's read; absent on older servers. */
  queue?: QueuedMessage[];
  /** The slash commands and skills the agent last offered, for the composer's `/` menu. Only on a single dork's read; absent on older servers. */
  commands?: AgentCommand[];
  codexModel?: { model: string; effort: string };
  codexModelChoices?: { model: string; efforts: string[] }[];
  /** Claude: the model and effort chosen for this session (absent: the agent's default). */
  model?: string;
  effort?: string;
  /** Claude: fast mode on (only for a model that offers it). Absent on older servers. */
  fast?: boolean;
  /** What the agent confirmed it runs: the model from its init event (a full id), the effort it was started with. */
  agentModel?: string;
  agentEffort?: string;
  /** The models the agent offers this account, as it last reported them. */
  modelChoices?: AgentModelChoice[];
  /** The build its machine starts from (docs/builds.md); null: the base snapshot. Absent on older servers. */
  buildId?: string | null;
  /** Where it runs (docs/local-dorks.md): a cloud sandbox, or the owner's computer. Absent on older servers: cloud. */
  location?: DorkLocation;
  /** code or nerd (docs/modes.md); a nerd plans and runs worker dorks instead of coding (docs/crew.md). Absent on older servers: code. */
  mode?: DorkMode;
  /** The coordinator that started this worker; null otherwise. Absent on older servers. */
  parentId?: string | null;
  /** A coordinator's emoji. */
  icon?: string;
  /** The teammate who started it on a team server (docs/cloud.md); absent for the local owner, automations and older servers. */
  createdBy?: Person;
  lastActivityAt: number;
  createdAt: number;
}

export interface CreateDorkInput {
  /** owner/name; optional for a setup session and in nerd mode. */
  repo?: string;
  /** The build to start from; null: the base machine; omitted: the default build, else the base machine. */
  buildId?: string | null;
  /** A machine-setup session for `buildId`: no repo needed, and the build needs no image yet. */
  setup?: boolean;
  /** code (default) or nerd (docs/modes.md). Only code needs a repo. */
  mode?: DorkMode;
  /** One emoji for a coordinator, shown in the sidebar. */
  icon?: string;
  message: string;
  title?: string;
  provider?: Provider;
  /** Claude: one of `Settings.claudeModels` (omit for the default), and one of its efforts. */
  model?: string;
  effort?: string;
  /** Claude: fast mode, for a model that offers it. */
  fast?: boolean;
  /** cloud (default) or local: on the owner's computer, only when `Settings.local.available` (docs/local-dorks.md). */
  location?: DorkLocation;
}

/** Plain values and booleans only: the server never returns a secret. */
export interface Settings {
  claudeToken: boolean;
  /** Antigravity is signed in with Google (agy's token, stored encrypted). */
  antigravityToken?: boolean;
  /** Antigravity can start: signed in with Google, or a shared secret for it. */
  antigravityReady?: boolean;
  /** Antigravity's Google sign-in while not signed in; null once it is. */
  antigravitySignIn?: AntigravitySignIn | null;
  /** The ChatGPT account Dorks' own Codex sign-in uses (kept by the Codex CLI on the server's computer); null when signed out. */
  codexAccount?: { email: string | null; plan: string | null } | null;
  /** Codex's ChatGPT sign-in while not signed in; null once it is. */
  codexSignIn?: CodexSignIn | null;
  /** The models Antigravity offers the signed-in plan (`agy models`), for a new session's menu. */
  antigravityModels?: AgentModelChoice[];
  /** The models the ChatGPT plan offered the last Codex session, for a new session's menu; empty until one has run. */
  codexModels?: AgentModelChoice[];
  boatKey: boolean;
  /** `problem`: why GitHub did not connect by itself (the GitHub CLI is missing or signed out). */
  github: { configured: boolean; login?: string | null; problem?: string };
  /** Connecting Boat with the Boat CLI's login while no key is saved; null once one is, or with simulated sandboxes. Absent on older servers. */
  boatSignIn?: BoatSignIn | null;
  boatOrg: string | null;
  boatEnvironment: string | null;
  baseSnapshotId: string | null;
  sleepMinutes: number;
  commentPolicy: CommentPolicy;
  /** New Claude sessions start in Code Mode; absent on older servers. */
  claudeCodeMode?: boolean;
  /** Every session may use this computer without asking (docs/local-access.md); absent on older servers. */
  localAlwaysAllow?: boolean;
  /** `boat` or `sim`; absent on older servers. */
  boxProvider?: string;
  /** Whether this client may start sessions on the server's computer (docs/local-dorks.md); never for a relayed client. Absent on older servers. */
  local?: LocalAvailability;
  /** Where the new-session composer starts: its Cloud / Local choice, remembered. Cloud when `local` is not available; local when `sandboxes` is not. */
  defaultLocation?: DorkLocation;
  /** Whether sessions may run in sandboxes: Dorks Teams and Dorks Cloud; Dorks Free runs them on the Mac. Absent on older servers (allowed). */
  sandboxes?: { available: boolean; reason?: string };
  /** This workspace's plan (`local` is Dorks Free). Absent on older servers. */
  plan?: PlanId;
  /** The models a Claude agent last reported (empty before any session started); what a new session can choose from. */
  claudeModels?: AgentModelChoice[];
  /** The build new sessions start on; null: the base snapshot. */
  defaultBuildId?: string | null;
  /** Sentry, for automations' Sentry triggers: connected when a token and organization are saved (the token never leaves the server). */
  sentry?: { connected: boolean; org: string | null; url: string | null };
}

/** The connected Sentry organization's projects, for a Sentry trigger; `error` when Sentry is not connected or cannot be read. */
export interface SentryProjects {
  org: string | null;
  projects: { slug: string; name: string; platform: string | null }[];
  error?: string;
}

export interface BuildInput {
  name?: string;
  machineType?: MachineType;
  setupScript?: string;
  repos?: BuildRepo[];
  services?: BuildService[];
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
  /** "" signs Antigravity out. */
  antigravityToken?: string;
  /** true: act as the GitHub CLI's login (the server checks it with GitHub first); false: disconnect. */
  githubConnected?: boolean;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  sleepMinutes?: number;
  commentPolicy?: CommentPolicy;
  /** New Claude sessions start in Code Mode; sessions already started keep what they had. */
  claudeCodeMode?: boolean;
  /** Every session may use this computer without asking. Off: each session asks once again; sessions already allowed stay allowed. */
  localAlwaysAllow?: boolean;
  /** Where new sessions start by default (the owner on this computer only). */
  defaultLocation?: DorkLocation;
  /** Sentry's personal token ("" disconnects), organization slug and a self-hosted Sentry's URL ("" for sentry.io). */
  sentryToken?: string;
  sentryOrg?: string;
  sentryUrl?: string;
}

/**
 * Boat sign-in with the Boat CLI on the owner's computer: `unavailable` (no CLI: paste a key in Settings), `checking`,
 * `signed_out` (one Sign in press), `signing_in` (finish in the browser at `url`), `connecting` (making Dorks' key), `failed`.
 */
export interface BoatSignIn {
  state: "unavailable" | "checking" | "signed_out" | "signing_in" | "connecting" | "failed";
  url?: string;
  userCode?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Antigravity's Google sign-in, run by the agy CLI on the server's computer: `signed_out` (one Sign in press), `installing` (Dorks
 * is downloading agy), `signing_in` (approve in the browser at `url`), `failed`.
 */
export interface AntigravitySignIn {
  state: "signed_out" | "installing" | "signing_in" | "failed";
  url?: string;
  error?: string;
  /**
   * The sign-in runs away from this browser (a cloud org: agy signs in inside a Boat sandbox), so Google's localhost redirect never
   * loads here: the address the browser ends on is always pasted (finishAntigravitySignIn).
   */
  remote?: boolean;
}

/** Codex's ChatGPT sign-in, run by the Codex CLI on the server's computer: `signed_out`, `signing_in` (approve at `url`), `failed`. */
export interface CodexSignIn {
  state: "signed_out" | "signing_in" | "failed";
  url?: string;
  error?: string;
}

/** `POST /api/boat/check`: whether Boat accepts a key (and organization) before anything is saved. */
/** Local access (docs/local-access.md): whether agents may ask to use this computer, and the sessions the owner allowed. */
export interface LocalSession {
  dorkId: string;
  dorkTitle: string;
  allowedAt: number;
}

/** The phone link (docs/mobile.md): this Mac paired with the iPhone app through the cloud relay. */
export interface PhoneStatus {
  cloudUrl: string | null;
  paired: boolean;
  macId: string | null;
  name: string | null;
  link: "off" | "connecting" | "online" | "offline";
  pairing: PhonePairing | null;
}

/** The Dorks Cloud account this server is signed in to (`GET /api/cloud`, docs/mobile.md "Desktop: Dorks Cloud"). */
export interface CloudStatus {
  /** The relay's origin; null when the cloud is off (`DORKS_CLOUD_URL` empty). */
  cloudUrl: string | null;
  user: CloudUser | null;
}

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** A server an organization owns: a member's Mac (`mac`), or the organization's always-on server (`hosted`). */
export interface CloudServer {
  id: string;
  name: string;
  kind: "mac" | "hosted";
  online: boolean;
  lastSeenAt: number | null;
}

/**
 * A Dorks Cloud organization (`GET /v1/orgs` on the relay). Every account has one `personal` org (named "Personal"); teams are the
 * others. `plan`: its plan (`local`, `teams`, `cloud`); `role`: the account's role in it; `servers`: the servers it owns.
 */
export interface CloudOrg {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  personal: boolean;
  plan: PlanId | null;
  role: string | null;
  active: boolean;
  servers: CloudServer[];
  /**
   * Where a paid org runs (the relay's `GET /v1/orgs`): `cloud` once the Worker serves it (it moved, or never had a Mac), `mac` while a
   * Mac still does. Absent from an older relay: the app then infers it from the org's servers.
   */
  runtime?: "cloud" | "mac";
}

/** A role in a Dorks Cloud organization; Better Auth may send a comma list, whose strongest counts. */
export type CloudRole = "owner" | "admin" | "member";

/** A member of an organization (Better Auth `get-full-organization`). */
export interface CloudMember {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; image?: string | null };
}

/** An invitation: to an org you manage (its pending invitations), or to you (`list-user-invitations`, `get-invitation`). */
export interface CloudInvitation {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | string;
  organizationId: string;
  organizationName?: string;
  inviterEmail?: string;
  expiresAt: string | number;
}

/** One signed-in session of the Dorks Cloud account (`GET /api/cloud/account`); `current` is this server's own. */
export interface CloudSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Settings › Account: the account, read fresh, and where it is signed in (`GET /api/cloud/account`). */
export interface CloudAccount {
  user: CloudUser;
  sessions: CloudSession[];
}

/** An organization with its members and invitations (`GET /api/cloud/auth/organization/get-full-organization`). */
export interface CloudOrgDetail {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  members: CloudMember[];
  invitations: CloudInvitation[];
}

/** `GET /api/cloud/move`: this Mac's move of its team org to the cloud (docs/move-to-cloud.md), in progress or the last one. */
export interface CloudMoveStatus {
  phase: "idle" | "pausing" | "uploading" | "committing" | "done" | "failed";
  orgId: string | null;
  importId: string | null;
  sessions: { done: number; total: number };
  events: { done: number; total: number };
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** The organization actions the UI posts through its server (Better Auth's `/api/auth/organization/*`). */
export type CloudOrgAction = "invite-member" | "cancel-invitation" | "accept-invitation" | "reject-invitation" | "update-member-role" | "remove-member" | "leave" | "update" | "delete";

/** `GET /api/cloud/places`: the account's organizations, personal first, with their servers. */
export interface CloudPlaces {
  orgs: CloudOrg[];
}

/** A Dorks Cloud trial (dorks-cloud src/entitlements.ts): Teams for some days, or Cloud for some sandbox minutes in all. */
export type CloudTrial = { kind: "teams_days"; endsAt: number | null } | { kind: "cloud_hours"; minutes: number; usedMinutes: number; minutesLeft: number; fallbackPlan: "local" | "teams" };

/**
 * `GET /api/cloud/orgs/:id/entitlements`: what the org's plan allows, from Dorks Cloud. On the Cloud trial `includedMinutes` is the
 * trial's minutes left; `periodEnd` (epoch ms) is null without a subscription; overage is opt-in, never past `capCents`.
 */
export interface CloudEntitlements {
  plan: PlanId;
  memberLimit: number;
  members: number;
  orgRuntime: boolean;
  /** Sandboxes on Dorks' Boat account (Cloud); Teams brings its own Boat key. */
  cloudCredit: boolean;
  includedMinutes: number;
  usedMinutes: number;
  periodEnd: number | null;
  overage: { enabled: boolean; capCents: number; spentCents: number };
  maxConcurrentSandboxes: number;
  trial: CloudTrial | null;
}

export interface PhonePairing {
  /** Shown as typed on the phone, `ABCD-2345`. */
  code: string;
  /** What the QR code holds: `dorks://pair?code=…&cloud=…`. */
  url: string;
  expiresAt: number;
}

export interface LocalAccess {
  enabled: boolean;
  sessions: LocalSession[];
}

/** The owner's answer to a session's first request: `session` allows this session, `always` every session (`localAlwaysAllow`). */
export type LocalDecision = { decision: "session" | "always" | "deny" };

/** The owner's answer to an agent's secure-input request (docs/secure-inputs.md): the values, or a dismissal. */
export type InputAnswer = { values: Record<string, string> } | { dismiss: true };

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
  /** The transcript advanced to `seq`. `events`: the rows that changed, from the first one on (a local server sends them when they fit); without them, read the tail. */
  | { t: "events"; dorkId: string; seq: number; events?: ClientEvent[] }
  | { t: "subscriptions"; dorkId: string }
  | { t: "comments"; dorkId: string }
  | { t: "settings" }
  | { t: "snapshot" }
  | { t: "builds" }
  | { t: "build"; buildId: string }
  | { t: "automations" }
  /** Who is looking at a dork now (docs/cloud.md, "Presence"); sent after `hello` for every dork with viewers, then on each change. */
  | { t: "presence"; dorkId: string; viewers: Person[] };

export interface PrRefInput {
  repo: string;
  number: number;
}

/**
 * How the GitHub connection stands: `ok`; `not_connected`; `gh_missing` / `gh_logged_out` (the GitHub CLI is not installed, or
 * not signed in); `rejected` (GitHub refused its token); `unreachable`.
 */
export type GithubAuthState = "ok" | "not_connected" | "gh_missing" | "gh_logged_out" | "rejected" | "unreachable";

/** `GET /api/github/repos`: the GitHub CLI login's user (null without one), its organizations, and its repositories (`owner/name`). */
export interface GithubRepos {
  login: string | null;
  orgs: string[];
  repos: string[];
  auth: {
    state: GithubAuthState;
    /** `gh`: the GitHub CLI's login; `env`: `GH_TOKEN` in the server's environment (development). */
    source: "gh" | "env" | null;
    /** OAuth scopes Dorks needs that the login lacks: `read:org` (lists organizations), `workflow` (pushes CI files). */
    missingScopes: string[];
  };
}

/**
 * `GET /api/github` (cloud orgs only, on the dorks-cloud Worker): the Dorks Agents GitHub App's installations linked to the org.
 * `configured` is false when the Worker has no App; `manageUrl` is GitHub's settings page for an installation (add repositories).
 */
export interface GithubConnection {
  configured: boolean;
  app: string | null;
  installations: { id: number; account: string; accountType: string | null; suspended: boolean; manageUrl?: string }[];
}

/** `GET /api/usage`: a part is missing when its credential is not set or its source failed. `used` is 0..1, times are epoch ms. */
export interface UsageWindow {
  used: number;
  resetsAt?: number;
}
export interface Usage {
  claude?: { session?: UsageWindow; weekly: UsageWindow };
  /** Antigravity's Google AI plan: its Gemini models' 5-hour and weekly limits. */
  google?: { session?: UsageWindow; weekly: UsageWindow };
  /** Boat: included machine time this period (hours), running sandboxes and starts against their limits, the wallet (dollars), why starts are refused. */
  cloud?: {
    usedHours?: number;
    includedHours?: number;
    periodEnd?: number;
    sandboxes?: UsageCount;
    startsHour?: UsageCount;
    startsDay?: UsageCount;
    walletDollars?: number;
    blocked?: string;
  };
}
export interface UsageCount {
  used: number;
  limit: number;
}

/**
 * The Twin Engine's setup for a Worker-run org (dorks-cloud src/prodlike/setup.ts, `GET /api/prodlike`): a scrubbed copy of production
 * that each session branches. Connect Neon (the owner's account) or hosted (Dorks runs a Neon project for the org).
 */
export type TwinStrategy = "keep" | "email" | "name" | "phone" | "address" | "ip" | "date" | "hash" | "redact" | "null";
export interface TwinColumn {
  schema: string;
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  strategy: TwinStrategy;
  reason: string;
  flagged: boolean;
  approved: boolean;
}
export interface TwinBuild {
  id: string;
  state: "queued" | "running" | "ready" | "failed";
  trigger: "setup" | "manual" | "automation";
  branch: string | null;
  stats: { tables: number; columns: number; masked: number; ms: number; warnings: string[] } | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export interface TwinView {
  allowed: boolean;
  plan: string;
  mode: "connect" | "hosted" | null;
  neon: { connected: boolean; method: "oauth" | "api_key" | null; oauthAvailable: boolean; connectedAt: number | null };
  hosted: {
    available: boolean;
    region: string | null;
    projectId: string | null;
    awaitingUrl: { sessionId: string; requestId: string } | null;
    usage: { computeHours: number; storageGbMonths: number; cents: number; since: number } | null;
  };
  twin: { envVar: string; orm?: string; migrations?: string; evidence?: string } | null;
  source: { kind: "neon"; projectId: string; branchId: string; database: string } | { kind: "url"; projectId: string; database: string; url?: string } | null;
  parent: { branchId: string; name: string; builtAt: number } | null;
  builds: TwinBuild[];
  rules: { columns: TwinColumn[]; masked: number; flagged: number; reviewedBy: string | null; reviewedAt: number | null; strategies: Record<TwinStrategy, string> } | null;
  refresh: { automationId: string; enabled: boolean; nextRunAt: number | null; schedule: string } | null;
  sessionsWithBranches: number;
}
export interface TwinNeonProject {
  id: string;
  name: string;
  region: string | null;
  orgId: string | null;
  orgName: string | null;
  createdAt: string | null;
  copy: boolean;
}
