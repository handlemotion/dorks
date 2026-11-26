import { z } from "zod";

// Builds (docs/builds.md): named machine setups. These are the wire shapes shared by the server, the web client and the bridge's
// `machine_*` MCP tools. The server is the only one that validates for real; the others use them to describe what they send.

export const MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;
export const machineType = z.enum(MACHINE_TYPES);
export type MachineType = z.infer<typeof machineType>;

/** Variable names: the same rule as CLI secrets. */
export const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SCRIPT_CHARS = 64 * 1024;
export const MAX_BUILD_REPOS = 10;
export const MAX_BUILD_NAME_CHARS = 60;

const repoName = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name")
  .refine((r) => r.split("/").every((s) => s !== "." && s !== ".."), "repo must be owner/name");

export const buildRepo = z.object({
  repo: repoName,
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s~^:?*[\\]+$/, "not a valid branch name")
    .optional(),
  setupScript: z.string().max(MAX_SCRIPT_CHARS).optional(),
});
export type BuildRepo = z.infer<typeof buildRepo>;

/** Service names: short, lowercase, as an agent types them (`service_start web`). */
export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_BUILD_SERVICES = 10;
/** Ports the box provider uses itself (Boat: SSH, the desktop stream, its agents), and the bridge's. */
export const RESERVED_PORTS = (port: number) => [22, 4748, 6080, 8090, 8911].includes(port) || (port >= 47984 && port <= 48010);

/**
 * A dev server or backing service of a build (docs/services.md): checked and warmed at build time (started until it listens, its first
 * page requested, then stopped, so the image holds its compiled caches), never started at boot. An agent starts it on demand with
 * `service_start`. `cwd` is relative to the work directory (`owner/name` or deeper); absent: the work directory itself.
 */
export const buildService = z.object({
  name: z.string().regex(SERVICE_NAME, "service names are lowercase letters, digits and dashes, e.g. web"),
  command: z.string().trim().min(1, "give the service a command").max(2000),
  cwd: z
    .string()
    .trim()
    .max(300)
    .regex(/^[\w.@+-]+(?:\/[\w.@+-]+)*$/, "cwd is a path under ~/work, like owner/name/apps/web")
    .refine((p) => p.split("/").every((s) => s !== "." && s !== ".."), "cwd is a path under ~/work, like owner/name/apps/web")
    .optional(),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .refine((p) => !RESERVED_PORTS(p), "that port is reserved in the box")
    .optional(),
  /** A UI the user should see: `service_start` shows it in the user's Artifacts as a running preview. Needs a port. */
  preview: z.boolean().optional(),
});
export type BuildService = z.infer<typeof buildService>;

/** What changes the image. Variable values are not part of it; the names of variables exported while building are. */
export interface BuildSpec {
  machineType: MachineType;
  setupScript: string;
  repos: BuildRepo[];
  /** Sorted names of the variables the setup script receives. */
  buildTimeVars: string[];
  /** Dev servers and services the agent can start on demand; checked and warmed at build time. */
  services: BuildService[];
}

/**
 * A change an agent proposes to one variable of its build. A plain variable may carry its value; a secret never does: the owner
 * types it in the UI. `remove` drops the variable.
 */
export const draftVar = z.object({
  name: z.string().regex(VAR_NAME, "variable names are UPPER_SNAKE_CASE"),
  secret: z.boolean().default(false),
  buildTime: z.boolean().default(false),
  value: z
    .string()
    .max(16 * 1024)
    .optional(),
  why: z.string().max(500).default(""),
  remove: z.boolean().optional(),
});
export type DraftVar = z.infer<typeof draftVar>;

export const RUN_STEPS = ["prepare", "create", "start", "clone", "setup", "scan", "save", "finish"] as const;
export type RunKind = "image" | "trial";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RunStep = (typeof RUN_STEPS)[number];

/**
 * A build run as the chat of the session it belongs to sees it (docs/builds.md): the agent's own runs (`machine_run`) and the image
 * build that follows the owner approving its draft. The server appends it again at every step, and the chat's card updates in place.
 */
export const chatRun = z.object({
  id: z.string(),
  buildId: z.string(),
  buildName: z.string(),
  kind: z.enum(["image", "trial"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  step: z.enum(RUN_STEPS).nullable(),
  /** Written for a person; for a failed setup it ends with the last lines of output. */
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type ChatRun = z.infer<typeof chatRun>;

export interface RunView {
  id: string;
  buildId: string;
  kind: RunKind;
  status: RunStatus;
  step: RunStep | null;
  /** `owner`, or `dork:<id>` for a run an agent started. */
  startedBy: string;
  /** Written for a person. */
  error: string | null;
  exitCode: number | null;
  specHash: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Bytes of (redacted) output stored so far. */
  logBytes: number;
}

export interface BuildVarView {
  name: string;
  secret: boolean;
  buildTime: boolean;
  /** Plain variables only. */
  value?: string;
  /** Asked for by an agent and still waiting for a value. */
  requested: boolean;
}

export interface DraftView {
  id: string;
  buildId: string;
  dorkId: string;
  dorkTitle: string;
  status: "editing" | "submitted" | "approved" | "rejected";
  spec: BuildSpec;
  specHash: string;
  vars: DraftVar[];
  note: string | null;
  /** The build changed since the draft was started from it. */
  stale: boolean;
  updatedAt: number;
}

export interface BuildView {
  id: string;
  name: string;
  machineType: MachineType;
  setupScript: string;
  repos: BuildRepo[];
  services: BuildService[];
  vars: BuildVarView[];
  rev: number;
  specHash: string;
  /** The current spec is the one the owner last approved. */
  approved: boolean;
  image: { name: string; at: number; stale: boolean; staleReason: string | null } | null;
  lastRun: RunView | null;
  activeRun: RunView | null;
  drafts: DraftView[];
  dorkCount: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}
