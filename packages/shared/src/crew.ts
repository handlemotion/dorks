import type { DorkState, TurnOutcome } from "./events";
import type { DorkMode } from "./modes";

// Crews (docs/crew.md): the session tools, served twice from this one table. The dorks server serves them to external agents over MCP
// (`POST /mcp`, the owner's tools) and the in-box `dorks` MCP server serves them to coordinators and workers (scoped by the server to
// the caller's crew). `audience` only decides what `tools/list` shows; every call is checked again on the server.

export type CrewRole = "coordinator" | "worker";
export type CrewAudience = "owner" | CrewRole;

/** Live (not archived) workers one coordinator may have at a time. */
export const MAX_LIVE_WORKERS = 8;
/** Crew notes one dork may send per hour (worker to coordinator or sibling): stops two agents from talking in a loop. */
export const MAX_NOTES_PER_HOUR = 30;
/** One wait inside the box (the bridge gives the server 10 s per call); the in-box tool repeats it up to the agent's timeout. */
export const CREW_WAIT_SLICE_MS = 8_000;
/** The UI listener closes a request idle for 255 s, so one wait stays under it; call again to keep waiting. */
export const MAX_WAIT_SECONDS = 240;
export const MAX_ANSWER_CHARS = 8_000;

export interface CrewToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  audience: CrewAudience[];
}

const ID = { type: "string", description: "The dork's id (from dork_create or dork_list)." } as const;
const RO = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true };

export const CREW_TOOLS: CrewToolDef[] = [
  {
    name: "dork_create",
    title: "Start a dork",
    description:
      "Start a new dork: an agent in its own cloud sandbox that works on `message`. In code mode (the default) it works on its own branch of `repo` and opens PRs; in chat mode it needs no repo " +
      "and suits research, writing, analysis and fixing things on the user's computer. It runs in the background; " +
      'a coordinator hears back automatically when the worker finishes a turn (a <dorks-event source="crew"> turn), anyone else can use dork_wait. ' +
      "Write `message` as a complete, self-contained task: the goal, the boundaries (which files or area it owns), what done looks like, how to verify it, and what to report back. " +
      "`model` is a Claude model alias such as opus or sonnet; `buildId` picks a machine setup from build_list (default: the owner's default build).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The task, as the dork's first message." },
        repo: { type: "string", description: "owner/name on GitHub. Required in code mode; chat and nerd sessions have none." },
        mode: {
          type: "string",
          enum: ["chat", "code", "nerd"],
          description: "code (default): works in `repo` and ships PRs. chat: a general assistant with no repo. nerd (owner only): plans and runs other dorks.",
        },
        title: { type: "string", description: "A short name (default: one is generated from the message)." },
        buildId: { type: "string", description: "A build id from build_list." },
        model: { type: "string", description: "A Claude model alias or id." },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        coordinator: { type: "boolean", description: "Owner only, the same as mode nerd: start a coordinator, which plans and delegates to worker dorks instead of writing code." },
        icon: { type: "string", description: "One emoji shown beside its name in the app." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: WRITE,
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_list",
    title: "List dorks",
    description:
      "List dorks with their mode, state, whether they are settled (done with their turn), repo, PR and the start of their last answer. A coordinator sees its workers, and with `all` every other session of the user too; a worker sees its crew (coordinator and sibling workers).",
    inputSchema: {
      type: "object",
      properties: {
        archived: { type: "boolean", description: "Archived ones instead of live ones." },
        query: { type: "string", description: "Only titles or repos containing this." },
        all: { type: "boolean", description: "Coordinator: also the user's other sessions, not only your workers." },
      },
      additionalProperties: false,
    },
    annotations: RO,
    audience: ["owner", "coordinator", "worker"],
  },
  {
    name: "dork_get",
    title: "Read a dork's status and last answer",
    description: "A dork's state, PR, how its last turn ended and its full final answer. Cheaper than dork_read when you only need the outcome.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
    annotations: RO,
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_read",
    title: "Read a dork's transcript",
    description:
      "A condensed transcript: messages, final answers, tool calls by name, notes and errors, oldest first. Page with `after` (the `next` cursor of the previous call). A coordinator can read any of the user's sessions.",
    inputSchema: {
      type: "object",
      properties: { id: ID, after: { type: "integer", description: "Only entries after this cursor." }, limit: { type: "integer", description: "Entries to read, 1 to 200 (default 60)." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: RO,
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_send",
    title: "Message a dork",
    description:
      "Send a dork a message. From the owner or a coordinator it is a user message: it steers the dork mid-turn or starts a new turn, and wakes it if it sleeps. " +
      "From a worker it is a note to its coordinator or a sibling worker, delivered when their current turn ends; use it to ask a question or hand over something they need, not for status (your final answer already reaches the coordinator). " +
      "From a coordinator to a session it did not start (one from dork_list with `all`) it is a note too: information delivered at their next turn boundary, never an instruction from the user.",
    inputSchema: { type: "object", properties: { id: ID, text: { type: "string", description: "The message." } }, required: ["id", "text"], additionalProperties: false },
    annotations: WRITE,
    audience: ["owner", "coordinator", "worker"],
  },
  {
    name: "dork_wait",
    title: "Wait for dorks to finish",
    description:
      "Wait until the named dorks settle (finish their turn, sleep or fail) and return their status and final answers. `mode` any (default) returns when the first settles, all when every one has. " +
      "Always returns by `timeoutSeconds` (default 120, at most 240) with `timedOut: true` if some are still working; call again to keep waiting. " +
      "A coordinator is woken by reports anyway: prefer ending your turn over waiting.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: ID, description: "The dorks to wait for." },
        mode: { type: "string", enum: ["any", "all"] },
        timeoutSeconds: { type: "integer", description: "1 to 240, default 120." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    annotations: RO,
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_stop",
    title: "Stop a dork's turn",
    description: "Interrupt what the dork is doing now (like the user's Stop). It keeps its sandbox and history and takes the next message.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_archive",
    title: "Archive a dork",
    description: "Archive a finished dork (its sandbox sleeps, it leaves the list; archived: false brings it back). Archiving a coordinator archives its workers.",
    inputSchema: { type: "object", properties: { id: ID, archived: { type: "boolean", description: "Default true." } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    audience: ["owner", "coordinator"],
  },
  {
    name: "dork_delete",
    title: "Delete a dork",
    description: "Delete a dork for good: its sandbox is destroyed (unpushed work is lost) and its transcript removed. Deleting a coordinator archives its workers.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    audience: ["owner"],
  },
  {
    name: "build_list",
    title: "List builds",
    description: "The machine setups (builds) a dork can start from: id, name, size, pre-cloned repos, whether its image is built and current, and which is the default.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: RO,
    audience: ["owner", "coordinator"],
  },
  {
    name: "build_run",
    title: "Run a build",
    description: "Start a run of a build: `image` rebuilds and saves its image (the approved spec), `trial` checks it in a throwaway machine. Returns at once with the run id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The build id." }, kind: { type: "string", enum: ["image", "trial"] } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
    audience: ["owner"],
  },
  {
    name: "repo_list",
    title: "List GitHub repositories",
    description: "Repositories (owner/name) the owner's GitHub login can reach, most recently pushed first.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Only names containing this." } }, additionalProperties: false },
    annotations: RO,
    audience: ["owner", "coordinator"],
  },
];

export const crewToolsFor = (who: CrewAudience) => CREW_TOOLS.filter((t) => t.audience.includes(who));

// ---------------------------------------------------------------- results (what the server returns, and how it reads as text)

export interface CrewAnswer {
  outcome: TurnOutcome | null;
  text: string;
  at: number;
  truncated?: boolean;
}

export interface CrewDork {
  id: string;
  title: string;
  mode: DorkMode;
  /** For a worker: its coordinator and siblings. For a coordinator: `other` marks a session that is not one of its workers. */
  role?: "coordinator" | "worker" | "you" | "other";
  state: DorkState;
  /** Done with its turn: idle, sleeping or error, and no message waiting for it. */
  settled: boolean;
  archived: boolean;
  repo: string;
  branch: string;
  parentId: string | null;
  prUrl?: string;
  prState?: string;
  lastAnswer?: CrewAnswer;
  lastActivityAt: number;
}

export interface CrewLine {
  seq: number;
  at: number;
  kind: "user" | "answer" | "message" | "tool" | "status" | "crew" | "notice" | "turn";
  text: string;
}

export interface CrewBuild {
  id: string;
  name: string;
  machineType: string;
  repos: string[];
  image: "none" | "current" | "stale";
  default: boolean;
}

export type CrewResult =
  | { tool: "dork_create"; id: string; title: string }
  | { tool: "dork_list"; dorks: CrewDork[] }
  | { tool: "dork_get"; dork: CrewDork }
  | { tool: "dork_read"; id: string; lines: CrewLine[]; next: number; hasMore: boolean }
  | { tool: "dork_send"; id: string; delivery: "message" | "note" }
  | { tool: "dork_wait"; dorks: CrewDork[]; timedOut: boolean }
  | { tool: "dork_stop"; id: string }
  | { tool: "dork_archive"; id: string }
  | { tool: "dork_delete"; id: string }
  | { tool: "build_list"; builds: CrewBuild[] }
  | { tool: "build_run"; buildId: string; runId: string; kind: string }
  | { tool: "repo_list"; repos: string[]; login: string | null };

const ago = (now: number, at: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function dorkLine(d: CrewDork, now: number, answerChars: number): string {
  const head = `- ${d.title} (id ${d.id})${d.role && d.role !== "worker" ? ` [${d.role}]` : ""} (${d.mode}): ${d.state}${d.settled ? ", settled" : ""}${d.archived ? ", archived" : ""}`;
  const where = [d.repo && `${d.repo} @ ${d.branch}`, d.prUrl && `PR ${d.prUrl}${d.prState ? ` (${d.prState})` : ""}`, `active ${ago(now, d.lastActivityAt)}`].filter(Boolean).join(" · ");
  const a = d.lastAnswer;
  const answer = a ? `\n  last turn ${a.outcome ?? "ended"}: ${a.text.length > answerChars ? a.text.slice(0, answerChars).trimEnd() + "…" : a.text}`.replace(/\n(?!  last)/g, "\n    ") : "";
  return `${head}\n  ${where}${answer}`;
}

function fullDork(d: CrewDork, now: number): string {
  const lines = [dorkLine({ ...d, lastAnswer: undefined }, now, 0)];
  if (d.lastAnswer) lines.push("", `Last turn: ${d.lastAnswer.outcome ?? "ended"}. Final answer:`, d.lastAnswer.text + (d.lastAnswer.truncated ? "\n[truncated]" : ""));
  else lines.push("", d.settled ? "No finished turn yet." : "Still on its first turn.");
  return lines.join("\n");
}

const RENDER: { [T in CrewResult["tool"]]: (r: Extract<CrewResult, { tool: T }>, now: number) => string } = {
  dork_create: (r) => `Started "${r.title}" (id ${r.id}). It works in the background.`,
  dork_list: (r, now) => (r.dorks.length ? r.dorks.map((d) => dorkLine(d, now, 300)).join("\n") : "No dorks."),
  dork_get: (r, now) => fullDork(r.dork, now),
  dork_read: (r) =>
    (r.lines.length ? r.lines.map((l) => `[${l.seq}] ${l.kind}: ${l.text}`).join("\n") : "Nothing new.") + (r.hasMore ? `\n\nMore: call again with after ${r.next}.` : `\n\n(cursor ${r.next})`),
  dork_send: (r) => (r.delivery === "message" ? `Sent to ${r.id}.` : `Note queued for ${r.id}; it is delivered when their current turn ends.`),
  dork_wait: (r, now) => (r.timedOut ? "Timed out; still waiting on some. Call dork_wait again to keep waiting.\n\n" : "") + r.dorks.map((d) => fullDork(d, now)).join("\n\n---\n\n"),
  dork_stop: (r) => `Stopped ${r.id}'s turn.`,
  dork_archive: (r) => `Done: ${r.id}.`,
  dork_delete: (r) => `Deleting ${r.id}.`,
  build_list: (r) =>
    r.builds.length
      ? r.builds.map((b) => `- ${b.name} (id ${b.id})${b.default ? " [default]" : ""}: ${b.machineType}, image ${b.image}${b.repos.length ? `, repos ${b.repos.join(", ")}` : ""}`).join("\n")
      : "No builds: dorks start from the base machine.",
  build_run: (r) => `Started a ${r.kind} run (${r.runId}) of build ${r.buildId}.`,
  repo_list: (r) => (r.repos.length ? r.repos.join("\n") : r.login ? "No matching repositories." : "GitHub is not connected."),
};

/** The text an agent reads for a result (also sent as `structuredContent` to external clients). */
export const renderCrew = (r: CrewResult, now = Date.now()): string => (RENDER[r.tool] as (r: CrewResult, now: number) => string)(r, now);
