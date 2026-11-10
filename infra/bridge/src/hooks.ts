import { CI_FIX_MAX_ATTEMPTS, NOTIFY_TAG, type SubscriptionView } from "@dorks/shared";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./credentials";
import { HOOK_EVENTS, type HookEvent } from "./hook-cli";
import { findPrUrls, prLabel, samePr, toRef } from "./pr-ref";
import type { PrSubscriptions } from "./prs";
import { errTag, type Log } from "./redact";
import type { RpcMethods } from "./rpc";
import type { Identity } from "./runas";
import { scanWork, type Finding } from "./work-scan";

// The bridge's side of the Claude Code hooks (docs/autonomy.md). Claude runs `dorks hook <event>` (hook-cli.ts), which forwards the hook's
// JSON input to the `hook.*` methods below and prints what they return:
//   Stop          the "done" gate: unpushed work, or a pushed branch without a PR, blocks the stop once
//   PostToolUse   backs up the gh shim: subscribes to PRs `gh pr create` printed, unsubscribes from ones `gh pr merge|close` ended
//   SessionStart  re-injects the subscribed PRs and how autonomy works after a start, resume or compaction
// A handler that throws answers nothing (Claude Code carries on as if the hook did not exist); `dorks hook` does the same when this
// process is unreachable.

/** Where the bridge writes the settings it hands to `claude --settings`. */
export const settingsPath = (stateDir: string) => join(stateDir, "claude-settings.json");

/**
 * The hooks as Claude Code settings. `--settings` is applied above the user's and the project's files, and hooks from every source
 * run, so the repo's own `.claude/settings.json` hooks still fire next to these. `dorks` is the bridge binary under its CLI role: run
 * through its absolute path so it does not depend on PATH inside the hook's shell.
 */
export function claudeSettings(self: [node: string, cli: string]) {
  const run = (event: HookEvent) => [{ type: "command", command: `${shellQuote(self[0])} ${shellQuote(self[1])} dorks hook ${event}`, timeout: HOOK_EVENTS[event].timeoutS }];
  return {
    hooks: {
      Stop: [{ hooks: run("stop") }],
      PostToolUse: [{ matcher: "Bash", hooks: run("post-tool-use") }],
      SessionStart: [{ matcher: "startup|resume|compact", hooks: run("session-start") }],
    },
  };
}

/** No secrets in it, but the Claude user must be able to read it (the state dir is only traversable for them under privilege separation). */
export function writeClaudeSettings(stateDir: string, self: [string, string]) {
  const file = settingsPath(stateDir);
  writeFileSync(file, JSON.stringify(claudeSettings(self), null, 2) + "\n");
  chmodSync(file, 0o644);
  return file;
}

/** Where the bridge writes the MCP server config it hands to `claude --mcp-config`. */
export const mcpConfigPath = (stateDir: string) => join(stateDir, "claude-mcp.json");

/**
 * The `dorks` MCP server (mcp.ts) as a Claude Code MCP config: the bridge binary under its CLI role, run through its absolute path.
 * The socket goes in the server's own `env`, so the server finds the bridge without relying on what Claude Code passes down.
 */
export function claudeMcpConfig(self: [node: string, cli: string], sock: string) {
  return { mcpServers: { dorks: { type: "stdio", command: self[0], args: [self[1], "dorks", "mcp"], env: { DORKS_SOCK: sock } } } };
}

/** No secrets in it (the socket path is not one), but the Claude user must be able to read it. */
export function writeClaudeMcpConfig(stateDir: string, self: [string, string], sock: string) {
  const file = mcpConfigPath(stateDir);
  writeFileSync(file, JSON.stringify(claudeMcpConfig(self, sock), null, 2) + "\n");
  chmodSync(file, 0o644);
  return file;
}

export interface HookDeps {
  workDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  runAs: Identity | null;
  prs: Pick<PrSubscriptions, "list" | "subscribe" | "unsubscribe">;
  /** Whether a pull request exists for a pushed branch (see pr-lookup.ts); null when unknown. */
  hasPr: (repo: string, branch: string) => Promise<boolean | null>;
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

  constructor(private d: HookDeps) {}

  readonly methods: RpcMethods = {
    "hook.stop": (p) => this.run("stop", () => this.stop(asInput(p))),
    "hook.postToolUse": (p) => this.run("post-tool-use", () => this.postToolUse(asInput(p))),
    "hook.sessionStart": (p) => this.run("session-start", () => this.sessionStart()),
  };

  /** What the agent was last asked to do: the kinds of the `notify` turn just written to it (none for a user message). */
  noteTurn(kinds: string[]) {
    this.turnKinds = kinds;
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
    // Claude Code is already continuing because an earlier Stop hook blocked: never block twice in a row.
    if (input.stop_hook_active === true) return null;
    // The turn answering a `ready` notification is "post a standby note", not "ship something".
    if (this.turnKinds.includes("ready")) return null;

    const subs = (await this.d.prs.list()) ?? [];
    const hasPr = async (repo: string, branch: string) =>
      subs.some((s) => s.headRef === branch && s.repo.toLowerCase() === repo.toLowerCase()) || this.d.hasPr(repo, branch);
    const found = await scanWork({ workDir: this.d.workDir, env: this.d.env, runAs: this.d.runAs, hasPr });

    // A condition is raised once. It is forgotten when it clears, so work that goes unpushed again later is raised again.
    const session = text(input.session_id);
    const raised = this.loadRaised(session);
    const present = new Set(found.map(conditionKey));
    const fresh = found.filter((f) => !raised.has(conditionKey(f)));
    this.saveRaised(session, [...raised].filter((k) => present.has(k)).concat(fresh.map(conditionKey)));
    if (!fresh.length) return null;

    this.d.log("hook stop: blocked for", [...new Set(fresh.map((f) => f.kind))].join(","));
    return { decision: "block", reason: stopReason(fresh) };
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
    if (input.tool_name !== "Bash") return null;
    const command = text(asInput(input.tool_input).command);
    const creates = CREATES_PRS.test(command);
    const ends = ENDS_PRS.test(command);
    if (!creates && !ends) return null; // every Bash call passes through here: no waiting on the subscription list for the ones that do not matter
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
    return null; // nothing that changes what the agent sees of the tool result
  }

  // ------------------------------------------------------------------ SessionStart
  private async sessionStart(): Promise<HookOutput> {
    const subs = await this.d.prs.list();
    this.d.log("hook session-start: described", subs?.length ?? "no", "subscriptions");
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(subs) } };
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
    "Before you stop: work in this box has not reached GitHub.",
    ...lines,
    "",
    "For each of them:",
    "1. Validate locally first. Run the repo's tests, typecheck and lint for what you changed, using the scripts the repo defines (package.json scripts, Makefile, CI config), and fix what fails.",
    "2. Push the branch (`git push -u origin <branch>`).",
    "3. Open a pull request with `gh pr create` (`gh stack submit` for a stack). That subscribes you to it, so CI results, reviews and conflicts wake you up.",
    "4. Or, if you are intentionally not pushing this work, say so in your reply and explain why. You will not be asked about it again.",
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
export function sessionContext(subs: SubscriptionView[] | null): string {
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
    "- When you start a web server the user should see (a dev server, a preview build), call the `preview_show` tool with its port: it opens in the user's Previews tab.",
    "- When a PR is ready (CI green and approved), post a short standby note in its thread and stop. Never merge it yourself.",
    "- If you stop with unpushed commits or a pushed branch without a PR, you will be asked once to push and open a PR, or to explain why you are not.",
  ].join("\n");
}
