import { createHash } from "node:crypto";
import { runGit } from "./git";
import type { Identity } from "./runas";
import { findRepos } from "./work-scan";

// The "test it for real" gate (docs/autonomy.md, "Live verification"): before an agent ends a turn that changed code, a small model
// judges from what the agent did whether it exercised the change against the real running software (a started server hit with real
// requests, the page opened in a browser, the CLI run), not only unit tests, mocks or a typecheck. If not, the Stop hook sends it back
// once with what to start and what to exercise. The bridge sees every tool call on the agent's event stream, so the judge gets the
// whole turn, which a Stop hook's own input (the final message alone) does not carry.

const MAX_STEPS = 80;
const MAX_STEP_CHARS = 240;
const MAX_REQUEST_CHARS = 2000;
const MAX_FILES = 40;
const GIT_TIMEOUT_MS = 10_000;

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|str_replace_based_edit_tool)$/;
/** Tools that drive a real browser or show a running server. */
const LIVE_TOOLS = /^mcp__dorks__(service_start|preview_show|screenshot_share)$|playwright|puppeteer|chrome|browser|computer/i;
/** A command that talks to something running in the box. */
const LIVE_COMMAND = /\b(curl|wget|xh|httpie|websocat|grpcurl|playwright|puppeteer|chromium|google-chrome|psql|redis-cli|mysql)\b/;
const LOCAL_TARGET = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|:\d{2,5}\b)/;

export type Verdict = "verified" | "needs_live_test" | "not_applicable";

/** What the agent did since the last turn that ended without being sent back. */
export class TurnActivity {
  private requests: string[] = [];
  private steps: { text: string; edit: boolean; live: boolean }[] = [];
  private dropped = 0;

  /** A user message or notification the agent got. */
  request(text: string) {
    this.requests.push(text.slice(0, MAX_REQUEST_CHARS));
    if (this.requests.length > 3) this.requests.shift();
  }

  /** One line of Claude Code's stream-json: its tool calls. Anything else is ignored. */
  ingest(raw: unknown) {
    const m = raw as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
    if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) return;
    for (const b of m.message.content as { type?: unknown; name?: unknown; input?: unknown }[]) if (b?.type === "tool_use" && typeof b.name === "string") this.tool(b.name, b.input);
  }

  tool(name: string, input: unknown) {
    const detail = describeInput(input);
    const edit = EDIT_TOOLS.test(name);
    const live = LIVE_TOOLS.test(name) || (LIVE_COMMAND.test(detail) && LOCAL_TARGET.test(detail));
    this.push({ text: `${name}${detail ? `: ${detail}` : ""}`, edit, live });
  }

  /** A shell command of an agent whose tool calls arrive on another stream (Codex, OpenCode, Antigravity). */
  shell(command: string) {
    this.tool("Bash", { command });
  }

  /** A service the agent started through the bridge (services.ts). */
  service(name: string) {
    this.push({ text: `service_start: ${name}`, edit: false, live: true });
  }

  private push(step: { text: string; edit: boolean; live: boolean }) {
    this.steps.push({ ...step, text: step.text.replace(/\s+/g, " ").slice(0, MAX_STEP_CHARS) });
    if (this.steps.length > MAX_STEPS) {
      this.steps.shift();
      this.dropped++;
    }
  }

  get edited() {
    return this.steps.some((s) => s.edit);
  }

  /** Something that looks like a live check came after the last edit (the fallback when the judge cannot answer). */
  get liveAfterEdit() {
    const last = this.steps.map((s) => s.edit).lastIndexOf(true);
    return this.steps.slice(last + 1).some((s) => s.live);
  }

  snapshot() {
    return { requests: [...this.requests], steps: this.steps.map((s) => s.text), dropped: this.dropped };
  }

  reset() {
    this.requests = [];
    this.steps = [];
    this.dropped = 0;
  }
}

function describeInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "notebook_path", "url", "code", "pattern", "name", "path", "query"]) if (typeof o[k] === "string" && o[k]) return String(o[k]);
  if (typeof o.port === "number") return `port ${o.port}`;
  try {
    return JSON.stringify(o);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- what changed on disk
/** repo dir -> HEAD and a hash of its status and diff: enough to tell whether a turn changed a working tree. */
export type WorkState = Map<string, { head: string; hash: string }>;

export interface GitCtx {
  workDir: string;
  env: NodeJS.ProcessEnv;
  runAs: Identity | null;
}

/**
 * These reads run beside the agent (the baseline is taken in the background when a turn ends): `git status` would otherwise take
 * `.git/index.lock` to refresh the index, and the agent's next `git add` or `git commit` would fail on it.
 */
export const READ_ONLY = ["--no-optional-locks"];

export async function workState(o: GitCtx): Promise<WorkState> {
  const repos: WorkState = new Map();
  await Promise.all(
    findRepos(o.workDir).map(async (dir) => {
      const git = (args: string[]) => runGit([...READ_ONLY, ...args], dir, o.env, o.runAs, GIT_TIMEOUT_MS);
      const [head, status, diff] = await Promise.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain=v1", "--untracked-files=all"]), git(["diff", "HEAD"])]);
      repos.set(dir, { head: head.stdout.trim(), hash: createHash("sha256").update(status.stdout).update("\0").update(diff.stdout).digest("hex") });
    }),
  );
  return repos;
}

/** Files that differ between two states (committed during the turn, or changed in the tree), relative to the work directory. */
export async function changedFiles(o: GitCtx, before: WorkState, after: WorkState): Promise<string[]> {
  const out: string[] = [];
  for (const [dir, now] of after) {
    const was = before.get(dir);
    if (was && was.head === now.head && was.hash === now.hash) continue;
    const git = (args: string[]) => runGit([...READ_ONLY, ...args], dir, o.env, o.runAs, GIT_TIMEOUT_MS);
    const committed = was?.head && was.head !== now.head ? (await git(["diff", "--name-only", was.head, "HEAD"])).stdout : "";
    const tree = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .join("\n");
    const rel = dir.startsWith(o.workDir) ? dir.slice(o.workDir.length).replace(/^\/+/, "") : dir;
    for (const f of new Set(`${committed}\n${tree}`.split("\n").filter(Boolean))) out.push(rel ? `${rel}/${f}` : f);
  }
  return out.slice(0, MAX_FILES + 1);
}

// ---------------------------------------------------------------- the judge
export interface ServiceSummary {
  name: string;
  port: number | null;
  preview: boolean;
  state: string;
}

export function judgePrompt(o: { requests: string[]; steps: string[]; dropped: number; files: string[]; services: ServiceSummary[]; finalMessage: string }): string {
  const files = o.files.length > MAX_FILES ? [...o.files.slice(0, MAX_FILES), "…and more"] : o.files;
  return [
    "You check one thing about a coding agent's work in a cloud sandbox: did it test its change against the real, running software before finishing?",
    "Below is what it was asked, every tool call it made in order (oldest first), the files that changed, the services this box can start, and its final message.",
    "",
    "Answer with exactly one of these verdicts:",
    '- "not_applicable": nothing here can be exercised by running it: docs, comments, markdown copy, CI or build configuration only, test files only, type-only changes, a dependency bump, or a turn that changed no code (a question, a review, research, a plan).',
    '- "verified": after its LAST edit to code, the agent ran the real program and exercised what changed: it started the dev server, app or service and sent real requests to the changed endpoints or pages (curl and the like), opened the page in a real browser or screenshotted it (preview_show, screenshot_share, Playwright against the running server), or ran the real CLI or script on real input. A final message that states a concrete reason it cannot run here (a missing credential or external service) also counts.',
    '- "needs_live_test": anything else. A change to behaviour (UI, server, API, worker, CLI, database) that was only unit-tested, typechecked, linted, built, mocked, or tested with jsdom, Vitest or Jest, or was exercised only before its last edit, needs a live test.',
    "",
    "<request>",
    o.requests.join("\n---\n") || "(none)",
    "</request>",
    "<tool_calls>",
    ...(o.dropped ? [`(${o.dropped} earlier calls not shown)`] : []),
    ...o.steps.map((s, i) => `${i + 1}. ${s}`),
    "</tool_calls>",
    "<changed_files>",
    files.join("\n") || "(none detected)",
    "</changed_files>",
    "<services>",
    o.services.map((s) => `${s.name}${s.port ? ` port ${s.port}` : ""}${s.preview ? " (UI)" : ""}: ${s.state}`).join("\n") || "(none defined)",
    "</services>",
    "<final_message>",
    o.finalMessage.slice(0, 3000) || "(none)",
    "</final_message>",
    "",
    'Reply with one line of JSON and nothing else: {"verdict": "...", "what": "..."}. For needs_live_test, "what" is one sentence naming what to start and exactly what to exercise for THIS change (which page, endpoint or command); otherwise an empty string.',
  ].join("\n");
}

/** The judge's reply, or null when it is unusable. */
export function parseVerdict(raw: string): { verdict: Verdict; what: string } | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { verdict?: unknown; what?: unknown };
    if (o.verdict !== "verified" && o.verdict !== "needs_live_test" && o.verdict !== "not_applicable") return null;
    return { verdict: o.verdict, what: typeof o.what === "string" ? o.what.replace(/\s+/g, " ").trim().slice(0, 500) : "" };
  } catch {
    return null;
  }
}

/** What the Stop hook tells the agent when its change was not exercised live. */
export function verifyReason(what: string, services: ServiceSummary[]): string {
  const listed = services.map((s) => `\`${s.name}\`${s.port ? ` (port ${s.port}${s.preview ? ", opens as a preview" : ""})` : ""}`).join(", ");
  return [
    "Before you stop: test this change against the real running software, not only with unit tests or a typecheck." + (what ? ` ${what}` : ""),
    services.length
      ? `- Start what it needs. This box has prebuilt services, installed and warmed: start them with the dorks \`service_start\` tool (${listed}); \`service_logs\` shows their output. Otherwise start the server yourself in the background (on 0.0.0.0) and wait until it answers.`
      : "- Start what it needs, in the background (on 0.0.0.0), and wait until it answers. The dorks `service_start` tool does that for you (give it a name, the command and the port) and keeps its log.",
    "- Exercise the changed behaviour for real. For UI: show it with `preview_show` and look at it with `screenshot_share` (or Playwright against the running server), going through what changed. For a backend: send real requests (curl) to the changed endpoints and check the responses, the server's log and the data.",
    "- Unit tests, typecheck, lint, builds, mocks, jsdom and Vitest or Jest runs do not count as this check.",
    "- If it truly cannot run in this box (a credential or an external service it lacks), say exactly what is missing in your final answer instead.",
    "Then report what you ran and what you saw.",
  ].join("\n");
}
