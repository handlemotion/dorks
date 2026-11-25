import { CI_FIX_MAX_ATTEMPTS, NOTIFY_TAG, RESERVED_MCP_NAMES, type McpServerConfig, type SubscriptionView } from "@dorks/shared";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./credentials";
import { HOOK_EVENTS, type HookEvent } from "./hook-cli";
import { findPrUrls, prLabel, samePr, toRef } from "./pr-ref";
import type { PrSubscriptions } from "./prs";
import { errTag, type Log } from "./redact";
import type { RpcMethods } from "./rpc";
import type { Identity } from "./runas";
import { changedFiles, judgePrompt, parseVerdict, TurnActivity, verifyReason, workState, type ServiceSummary, type WorkState } from "./verify";
import { scanWork, type BranchPrStatus, type Finding } from "./work-scan";
import type { SecretInputs } from "./inputs";

// The bridge's side of the Claude Code hooks (docs/autonomy.md). Claude runs `dorks hook <event>` (hook-cli.ts), which forwards the hook's
// JSON input to the `hook.*` methods below and prints what they return:
//   Stop          the "done" gates: a code change not tested against running software (verify.ts, judged by a small model), and
//                 uncommitted or unpushed work, or a pushed branch without a PR; each blocks the stop once
//   PreToolUse    fills in secure inputs: a `{{secret:NAME}}` in a tool's input becomes the owner's value (inputs.ts)
//   PostToolUse   redacts secure inputs from every tool's output (inputs.ts); for Bash, also backs up the gh shim: subscribes to PRs
//                 `gh pr create` printed, unsubscribes from ones `gh pr merge|close` ended
//   SessionStart  re-injects the subscribed PRs and how autonomy works after a start, resume or compaction
// A handler that throws answers nothing (Claude Code carries on as if the hook did not exist); `dorks hook` does the same when this
// process is unreachable.

/** Per-dork switches that ride on the `--settings` file: fast mode (the CLI's `fastMode`) and Code Mode. */
export interface SettingsFlags {
  fast?: boolean;
  codeMode?: boolean;
}

/** Where the bridge writes the settings it hands to `claude --settings`: one file per combination of flags, next to the hooks. */
export const settingsPath = (stateDir: string, f: SettingsFlags = {}) => join(stateDir, `claude-settings${f.fast ? "-fast" : ""}${f.codeMode ? "-code" : ""}.json`);

/**
 * The hooks as Claude Code settings. `--settings` is applied above the user's and the project's files, and hooks from every source
 * run, so the repo's own `.claude/settings.json` hooks still fire next to these. `dorks` is the bridge binary under its CLI role: run
 * through its absolute path so it does not depend on PATH inside the hook's shell.
 * `attribution` empty turns off the CLI's own Co-Authored-By / "Generated with Claude Code" lines on commits and PRs, on every machine:
 * flag settings sit above the user's and the repo's files, so neither can turn it back on.
 * Code Mode (Claude writes code that makes several tool calls in one step) is on only for a dork created with it: claude -p turns it on
 * only from the env block of --settings, and a session started in Code Mode can only be resumed with it on (and the reverse is fine).
 */
function claudeSettings(self: [node: string, cli: string]) {
  const run = (event: HookEvent) => [{ type: "command", command: `${shellQuote(self[0])} ${shellQuote(self[1])} dorks hook ${event}`, timeout: HOOK_EVENTS[event].timeoutS }];
  return {
    attribution: { commit: "", pr: "" },
    hooks: {
      Stop: [{ hooks: run("stop") }],
      // Every tool: a secure input may be used by, or turn up in the output of, any of them.
      PreToolUse: [{ matcher: "*", hooks: run("pre-tool-use") }],
      PostToolUse: [{ matcher: "*", hooks: run("post-tool-use") }],
      SessionStart: [{ matcher: "startup|resume|compact", hooks: run("session-start") }],
    },
  };
}

/** No secrets in it, but the Claude user must be able to read it (the state dir is only traversable for them under privilege separation). */
export function writeClaudeSettings(stateDir: string, self: [string, string]) {
  // One file per combination, so fast mode and Code Mode ride on the one `--settings` flag next to the hooks.
  for (const fast of [false, true])
    for (const codeMode of [false, true]) {
      const file = settingsPath(stateDir, { fast, codeMode });
      const settings = { ...claudeSettings(self), ...(fast ? { fastMode: true } : {}), ...(codeMode ? { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } } : {}) };
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      chmodSync(file, 0o644);
    }
  return settingsPath(stateDir);
}

/** Where the bridge writes the MCP server config it hands to `claude --mcp-config`. */
export const mcpConfigPath = (stateDir: string) => join(stateDir, "claude-mcp.json");

/**
 * The `dorks` MCP server (mcp.ts) as a Claude Code MCP config: the bridge binary under its CLI role, run through its absolute path.
 * The socket goes in the server's own `env`, so the server finds the bridge without relying on what Claude Code passes down.
 * `user` adds the owner's servers from Customize (see `userMcpServers`); it never replaces `dorks`.
 */
export function claudeMcpConfig(self: [node: string, cli: string], sock: string, user: Record<string, unknown> = {}) {
  return { mcpServers: { ...user, dorks: { type: "stdio", command: self[0], args: [self[1], "dorks", "mcp"], env: { DORKS_SOCK: sock } } } };
}

/**
 * The owner's MCP servers (Customize) as Claude Code config entries, with every header and env value replaced by a `${DORKS_MCP_…}`
 * reference: the CLI expands those from its own environment, so the values reach the agent's environment (like any shared secret)
 * but never the config file on disk. The URL is a reference too, since hosted servers often put a key in it. `env` holds the values to add to the agent's environment.
 * An OAuth server points at `proxyUrl` instead (left out without one), so no token reaches the config or the environment.
 */
export function userMcpServers(servers: readonly McpServerConfig[], proxyUrl?: (name: string) => string): { config: Record<string, unknown>; env: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  servers.forEach((s, i) => {
    if (RESERVED_MCP_NAMES.includes(s.name)) return;
    if (s.transport === "http" && s.oauth) {
      // Signed in with OAuth: the bridge's loopback proxy (mcp-proxy.ts) adds a current token and the server's headers.
      if (!proxyUrl) return;
      env[`DORKS_MCP_${i}_URL`] = proxyUrl(s.name); // a reference too: the path is the proxy's secret, and this file is world-readable
      config[s.name] = { type: "http", url: `\${DORKS_MCP_${i}_URL}` };
      return;
    }
    const refs = (values: Record<string, string>, kind: string) =>
      Object.fromEntries(
        Object.entries(values).map(([k, v], j) => {
          const name = `DORKS_MCP_${i}_${kind}${j}`;
          env[name] = v;
          return [k, `\${${name}}`];
        }),
      );
    if (s.transport === "http") env[`DORKS_MCP_${i}_URL`] = s.url; // hosted servers often carry a key in the URL (Composio's do)
    config[s.name] =
      s.transport === "http" ? { type: "http", url: `\${DORKS_MCP_${i}_URL}`, headers: refs(s.headers, "H") } : { type: "stdio", command: s.command, args: s.args, env: refs(s.env, "E") };
  });
  return { config, env };
}

/** No secrets in it (the socket path is not one, user values are `${…}` references), but the Claude user must be able to read it. */
export function writeClaudeMcpConfig(stateDir: string, self: [string, string], sock: string, user: Record<string, unknown> = {}) {
  const file = mcpConfigPath(stateDir);
  writeFileSync(file, JSON.stringify(claudeMcpConfig(self, sock, user), null, 2) + "\n");
  chmodSync(file, 0o644);
  return file;
}

export interface HookDeps {
  workDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  runAs: Identity | null;
  prs: Pick<PrSubscriptions, "list" | "subscribe" | "unsubscribe">;
  /** Pull request status for a pushed branch (see pr-lookup.ts); null when unknown. */
  prStatus: (repo: string, branch: string) => Promise<BranchPrStatus | null>;
  /** The build's services and their state (services.ts), for the SessionStart context and the verify gate. */
  services?: () => ServiceSummary[];
  /** One answer from a small model (Haiku for Claude), for the verify gate; null or a rejection when none can be had. */
  judge?: (prompt: string) => Promise<string | null>;
  /** No verify gate for this session (a crew coordinator, which writes no code). */
  skipVerify?: () => boolean;
  /** Secure inputs (docs/secure-inputs.md): filled into tool inputs, redacted from tool outputs. */
  inputs?: Pick<SecretInputs, "preToolUse" | "postToolUse">;
  /** Coding autonomy is on for this session's mode (docs/modes.md): off for a chat, which ships nothing. Default: on. */
  autonomy?: () => boolean;
  log: Log;
}

type HookInput = Record<string, unknown>;
type HookOutput = Record<string, unknown> | null;

const CREATES_PRS = /\bgh\b[^;&|\n]*\b(?:pr\s+create|stack\s+submit)\b/;
const ENDS_PRS = /\bgh\b[^;&|\n]*\bpr\s+(?:merge|close)\b/;
/** What gh prints on success: "✓ Closed pull request owner/name#12 (title)", "✓ Squashed and merged pull request owner/name#12 (title)". `--auto` prints something else. */
const ENDED = /\b(?:closed|merged) pull request ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})\b/gi;
const MAX_LISTED = 8;
const MAX_TITLE = 120;

const text = (v: unknown) => (typeof v === "string" ? v : "");
const asInput = (v: unknown): HookInput => (v && typeof v === "object" && !Array.isArray(v) ? (v as HookInput) : {});

export class HookService {
  private turnKinds: string[] = [];
  /** What the agent did since the last turn that ended without being sent back (verify.ts). */
  readonly activity = new TurnActivity();
  /** The working trees when that turn ended: what tells this turn's changes apart. Null until taken, or when it could not be. */
  private baseline: Promise<WorkState | null> | null = null;

  constructor(private d: HookDeps) {}

  /** A turn ended and stays ended (or the agent just started): what comes next is judged against the trees as they are now. */
  turnBoundary() {
    this.activity.reset();
    this.baseline = workState({ workDir: this.d.workDir, env: this.d.env, runAs: this.d.runAs }).catch(() => null);
  }

  readonly methods: RpcMethods = {
    "hook.stop": (p) => this.run("stop", () => this.stop(asInput(p))),
    "hook.preToolUse": (p) => this.run("pre-tool-use", async () => (await this.d.inputs?.preToolUse(asInput(p))) ?? null),
    "hook.postToolUse": (p) => this.run("post-tool-use", () => this.postToolUse(asInput(p))),
    "hook.sessionStart": (p) => this.run("session-start", () => this.sessionStart()),
  };

  /** What the agent was last asked to do: the kinds of the `notify` turn just written to it (none for a user message), and its text. */
  noteTurn(kinds: string[], text?: string) {
    this.turnKinds = kinds;
    if (text) this.activity.request(text);
  }

  private async run(event: HookEvent, handler: () => Promise<HookOutput>): Promise<HookOutput> {
    try {
      return await handler();
    } catch (e) {
      this.d.log(`hook ${event} failed:`, errTag(e));
      return null; // fail open
    }
  }

  // ------------------------------------------------------------------ Stop
  private async stop(input: HookInput): Promise<HookOutput> {
    // A chat ships nothing as a pull request: there is no unshipped work to hold it back for.
    if (this.d.autonomy?.() === false) return this.allow();
    // Claude Code is already continuing because an earlier Stop hook blocked: never block twice in a row.
    if (input.stop_hook_active === true) return this.allow();
    // The turn answering a `ready` notification is "post a standby note", not "ship something".
    if (this.turnKinds.includes("ready")) return this.allow();

    const verifying = this.verify(text(input.last_assistant_message)).catch((e) => {
      this.d.log("hook stop: verify gate failed:", errTag(e));
      return null;
    });

    const subs = (await this.d.prs.list()) ?? [];
    const prStatus = async (repo: string, branch: string): Promise<BranchPrStatus | null> => {
      // Check GitHub live first so a PR merged or closed since the last poll is caught immediately.
      // Fall back to cached open subscriptions only when live lookup is unavailable.
      const live = await this.d.prStatus(repo, branch);
      if (live !== null) return live;
      return subs.some((s) => s.state === "open" && s.headRef === branch && s.repo.toLowerCase() === repo.toLowerCase()) ? { state: "open" } : null;
    };
    const found = await scanWork({ workDir: this.d.workDir, env: this.d.env, runAs: this.d.runAs, prStatus });

    // A condition is raised once. It is forgotten when it clears, so work that goes unpushed again later is raised again.
    const session = text(input.session_id);
    const raised = this.loadRaised(session);
    const present = new Set(found.map(conditionKey));
    const fresh = found.filter((f) => !raised.has(conditionKey(f)));
    this.saveRaised(session, [...raised].filter((k) => present.has(k)).concat(fresh.map(conditionKey)));
    const verify = await verifying;
    if (!fresh.length && !verify) return this.allow();

    this.d.log("hook stop: blocked for", [...(verify ? ["verify"] : []), ...new Set(fresh.map((f) => f.kind))].join(","));
    // Test first, then ship: one block carries both, since the continuation it starts is never blocked again.
    return { decision: "block", reason: [verify, fresh.length ? stopReason(fresh) : null].filter(Boolean).join("\n\n") };
  }

  /** The stop goes through: the next turn is judged on its own. */
  private allow(): null {
    this.turnBoundary();
    return null;
  }

  /**
   * The verify gate (verify.ts): did a turn that changed code test it against the running software? Null to let it stop, else the
   * reason to send it back with. A small model judges from the turn's tool calls; without one, a live-looking step after the last
   * edit is enough.
   */
  private async verify(finalMessage: string): Promise<string | null> {
    if (!this.d.judge || this.d.skipVerify?.()) return null; // no judge configured: the gate is off (the bridge always has one)
    const ctx = { workDir: this.d.workDir, env: this.d.env, runAs: this.d.runAs };
    const [before, after] = await Promise.all([this.baseline ?? Promise.resolve(null), workState(ctx).catch(() => null)]);
    const files = before && after ? await changedFiles(ctx, before, after) : [];
    // Nothing on disk changed this turn and no edit tool ran (a question, a review): nothing to test.
    if (!files.length && !this.activity.edited) return null;
    const services = this.d.services?.() ?? [];
    const prompt = judgePrompt({ ...this.activity.snapshot(), files, services, finalMessage });
    const raw = this.d.judge ? await this.d.judge(prompt).catch(() => null) : null;
    const verdict = raw ? parseVerdict(raw) : null;
    if (verdict) {
      this.d.log("hook stop: verify verdict", verdict.verdict);
      return verdict.verdict === "needs_live_test" ? verifyReason(verdict.what, services) : null;
    }
    this.d.log("hook stop: verify judge gave no verdict, using the fallback");
    return this.activity.liveAfterEdit ? null : verifyReason("", services);
  }

  private raisedFile() {
    return join(this.d.stateDir, "stop-gate.json");
  }

  /** The conditions already raised in this session. Persisted, because the bridge restarts whenever the box wakes from a pause. */
  private loadRaised(session: string): Set<string> {
    try {
      const saved = JSON.parse(readFileSync(this.raisedFile(), "utf8")) as { session?: unknown; raised?: unknown };
      if (saved.session === session && Array.isArray(saved.raised)) return new Set(saved.raised.filter((k): k is string => typeof k === "string"));
    } catch {
      /* none yet, or unreadable: nothing was raised */
    }
    return new Set();
  }

  private saveRaised(session: string, raised: string[]) {
    try {
      writeFileSync(this.raisedFile(), JSON.stringify({ session, raised }), { mode: 0o600 });
    } catch {
      this.d.log("hook stop: could not save the raised conditions"); // in the worst case the next wake raises them once more
    }
  }

  // ------------------------------------------------------------------ PostToolUse
  private async postToolUse(input: HookInput): Promise<HookOutput> {
    const redacted = this.d.inputs?.postToolUse(input) ?? null;
    if (input.tool_name === "Bash") await this.followPrs(input);
    return redacted; // null: nothing changes what the agent sees of the tool result
  }

  private async followPrs(input: HookInput): Promise<void> {
    const command = text(asInput(input.tool_input).command);
    const creates = CREATES_PRS.test(command);
    const ends = ENDS_PRS.test(command);
    if (!creates && !ends) return; // every Bash call passes through here: no waiting on the subscription list for the ones that do not matter
    const output = toolOutput(input.tool_response);
    const known = await this.d.prs.list();

    if (creates) {
      // The shim normally got there first; subscribing is idempotent, but skipping what is already listed saves the round trip.
      for (const ref of findPrUrls(output)) if (!known?.some((s) => samePr(s, ref))) await this.d.prs.subscribe(ref, "auto");
    }
    if (ends) {
      for (const m of output.matchAll(ENDED)) {
        const ref = toRef(m[1], m[2]);
        if (ref && known?.some((s) => samePr(s, ref))) await this.d.prs.unsubscribe(ref);
      }
    }
  }

  // ------------------------------------------------------------------ SessionStart
  private async sessionStart(): Promise<HookOutput> {
    if (this.d.autonomy?.() === false) return null; // a chat: no PR subscriptions, no "ship it" rules
    const subs = await this.d.prs.list();
    this.d.log("hook session-start: described", subs?.length ?? "no", "subscriptions");
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(subs, this.d.services?.() ?? []) } };
  }
}

const conditionKey = (f: Finding) => `${f.kind}\t${f.dir}\t${f.branch}`;

/** The Bash tool's result as one string: `{ stdout, stderr, … }`, or a plain string in older versions. */
function toolOutput(response: unknown): string {
  if (typeof response === "string") return response;
  const r = asInput(response);
  return `${text(r.stdout)}\n${text(r.stderr)}`;
}

export function stopReason(found: Finding[]): string {
  const lines = found.slice(0, MAX_LISTED).map((f) => `- ${f.repo ?? "repository"} at ${f.dir}, branch ${f.branch}: ${f.detail}`);
  if (found.length > MAX_LISTED) lines.push(`- and ${found.length - MAX_LISTED} more (see \`git branch -vv\` in your repositories)`);
  return [
    "Do not stop yet: work in this box has not reached GitHub, and every change you make here ships as a pull request.",
    ...lines,
    "",
    "The user has authorized you to commit, push and open pull requests for your work in this box: do not stop to ask whether to. For each of them, now:",
    "1. Validate locally first. Run the repo's tests, typecheck and lint for what you changed, using the scripts the repo defines (package.json scripts, Makefile, CI config), and fix what fails.",
    "2. Commit what is uncommitted, on a new branch if you are on the default branch (follow the repo's branching rules).",
    "3. Push the branch (`git push -u origin <branch>`).",
    "4. Open a pull request with `gh pr create` (`gh stack submit` for a stack), or push to the PR it belongs to. If a branch's PR is already merged or closed, create a new branch from the latest default branch, cherry-pick your new commits onto it, push, and open a new PR. That subscribes you to it, so CI results, reviews and conflicts wake you up.",
    "5. Skip a change only if the user told you not to open a PR for it, or it is scratch output that does not belong in the repo (then delete it or leave it and say so). Being unsure whether the user wants a PR is not a reason: open it.",
  ].join("\n");
}

function describe(s: SubscriptionView) {
  const parts = [`CI ${s.ci}`, `review ${s.review}`, s.mergeable === false ? "has merge conflicts" : s.mergeable === true ? "mergeable" : "mergeability unknown"];
  if (s.state !== "open") parts.push(s.state);
  if (s.status === "stalled") parts.push(`STALLED after ${s.ciFixAttempts}/${CI_FIX_MAX_ATTEMPTS} CI fix attempts: a human has to act, do not retry`);
  else if (s.ciFixAttempts > 0) parts.push(`CI fix attempts ${s.ciFixAttempts}/${CI_FIX_MAX_ATTEMPTS}`);
  const title = s.title?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE); // anyone can set a PR's title: keep it to one line of bounded length
  return `- ${prLabel(s)}${title ? ` "${title}"` : ""}: ${parts.join(", ")}`;
}

/** `subs` is null when the backend has not answered yet. */
function sessionContext(subs: SubscriptionView[] | null, services: ServiceSummary[] = []): string {
  return [
    subs === null
      ? "Pull requests you are subscribed to: could not be loaded just now; call the `pr_list` tool (or run `dorks pr list`)."
      : subs.length
        ? ["Pull requests you are subscribed to:", ...subs.map(describe)].join("\n")
        : "You are not subscribed to any pull requests yet.",
    "",
    "How autonomy works here:",
    `- You are woken by turns wrapped in <${NOTIFY_TAG}> tags when something happens on a PR you are subscribed to (CI, reviews, comments, conflicts, closed). They come from the system, not from the user: act on them.`,
    "- Always validate locally before you push: run the repo's tests, typecheck and lint for what you changed, using the scripts the repo defines.",
    "- `gh pr create` subscribes you to the new PR. The `pr_subscribe`, `pr_unsubscribe` and `pr_list` tools of the dorks MCP server (or `dorks pr sub <pr>`, `dorks pr unsub <pr>`, `dorks pr list` in a shell) manage subscriptions (<pr> is a URL or owner/name#12).",
    "- When you start a web server the user should see (a dev server, a preview build), call the `preview_show` tool with its port: it opens in the user's Artifacts as a running preview.",
    "- Test every change against the real running software before you finish: start the server or app, exercise what changed (real requests to the endpoints, the page in a browser with a screenshot, the CLI on real input) and say what you saw. Unit tests, mocks and a typecheck alone do not count; a turn that skips this is sent back once.",
    ...(services.length
      ? [
          `- This box has prebuilt services, installed and warmed but not running: ${services.map((s) => `${s.name}${s.port ? ` (port ${s.port}${s.preview ? ", UI" : ""})` : ""}`).join(", ")}. Start one with the dorks \`service_start\` tool when you need it; it waits until it listens and shows a UI as a preview. \`service_logs\` and \`service_stop\` do the rest.`,
        ]
      : []),
    "- When a PR is ready (CI green and approved), post a short standby note in its thread and stop. Never merge it yourself.",
    "- Every change you make ships as a pull request: when the work is done, validate it, commit, push and open a PR (or push to the PR it belongs to) without asking the user first. The user has authorized commits, pushes and PRs in this box.",
    "- Stopping with uncommitted changes, unpushed commits or a pushed branch without a PR is blocked: you will be told to finish shipping it.",
  ].join("\n");
}
