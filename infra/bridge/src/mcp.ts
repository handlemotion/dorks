import { CREW_WAIT_SLICE_MS, crewToolsFor, MAX_WAIT_SECONDS, renderCrew, type CrewResult, type CrewRole, type PrRef, type SubscriptionView } from "@dorks/shared";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { describeRpcError, listLine, socketOf } from "./dorks";
import { parsePrRef, prLabel, samePr } from "./pr-ref";
import type { ShownPreview } from "./previews";
import { rpcCall } from "./rpc";

// `dorks mcp`: the same agent surface as `dorks pr …`, as MCP tools (Model Context Protocol) so the agent calls them as typed tools
// instead of shelling out. It is a stdio MCP server: Claude Code starts it from the bridge-written `mcp.json` (hooks.ts `claudeMcpConfig`,
// passed as `claude --mcp-config`), speaks newline-delimited JSON-RPC 2.0 to it, and it forwards every call to the running bridge on
// DORKS_SOCK. Nothing here holds state or a credential; the backend stays the single owner of the truth.
//
// Hand-rolled on purpose: the bridge ships as one dependency-light bundle and the server needs four methods (initialize, ping,
// tools/list, tools/call), so the MCP SDK would only add weight to every box snapshot.

/** The server name; Claude Code prefixes the tools with it, so the agent sees `mcp__dorks__pr_subscribe`. */
export const MCP_SERVER_NAME = "dorks";
/** Versions we can speak. A client asking for another one is answered with the newest, as the spec requires. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PR_PARAM = { type: "string", description: "The pull request: a URL like https://github.com/owner/name/pull/12, or owner/name#12." } as const;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>, sock: string) => Promise<string | Content[]>;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Thrown by a tool for a problem the agent should read and act on; it becomes a tool result with `isError`, not a protocol error. */
class ToolError extends Error {}

function prArg(args: Record<string, unknown>): PrRef {
  const ref = typeof args.pr === "string" ? parsePrRef(args.pr) : null;
  if (!ref) throw new ToolError("`pr` must be a pull request URL (https://github.com/owner/name/pull/12) or owner/name#12.");
  return ref;
}

const TOOLS: Tool[] = [
  {
    name: "pr_subscribe",
    title: "Subscribe to a pull request",
    description:
      "Get woken up when something happens on a pull request: CI fails or passes, a review or comment arrives, a merge conflict appears, or it is merged or closed. " +
      "`gh pr create` already subscribes you to the PRs you open, so use this for a PR someone else opened or one you were pointed at. Idempotent.",
    inputSchema: { type: "object", properties: { pr: PR_PARAM }, required: ["pr"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const ref = prArg(args);
      await rpcCall(sock, "pr.sub", { ...ref, source: "agent" });
      return `Subscribed to ${prLabel(ref)}. Notifications about it arrive as <dorks-event> turns.`;
    },
  },
  {
    name: "pr_unsubscribe",
    title: "Unsubscribe from a pull request",
    description: "Stop being notified about a pull request. Use it when you are done with a PR or it is being handled elsewhere. Merged and closed PRs end by themselves.",
    inputSchema: { type: "object", properties: { pr: PR_PARAM }, required: ["pr"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const ref = prArg(args);
      await rpcCall(sock, "pr.unsub", ref);
      return `Unsubscribed from ${prLabel(ref)}.`;
    },
  },
  {
    name: "pr_list",
    title: "List subscribed pull requests",
    description:
      "The pull requests you are subscribed to, with CI, review and mergeability state and how many CI fix attempts are used. A STALLED PR needs a human: do not keep retrying it. " +
      "Pass `pr` to look at one of them.",
    inputSchema: { type: "object", properties: { pr: { ...PR_PARAM, description: "Optional: only this pull request. " + PR_PARAM.description } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const only = args.pr === undefined ? null : prArg(args);
      const all = await rpcCall<SubscriptionView[]>(sock, "pr.list");
      const subs = only ? all.filter((s) => samePr(s, only)) : all;
      if (only && !subs.length) return `You are not subscribed to ${prLabel(only)}.`;
      return subs.length ? subs.map(listLine).join("\n") : "No PR subscriptions.";
    },
  },
  {
    name: "preview_show",
    title: "Show a dev server to the user",
    description:
      "Open a web server running in this box in the user's Artifacts as a running preview, so they can see and click through it. Call it once the server answers " +
      "(e.g. `curl -sI localhost:3000`), and again after restarting it on another port. Start servers on 0.0.0.0 when you can " +
      "(`--host 0.0.0.0`); pass `localhost: true` only for one that listens on 127.0.0.1 alone. The page is served from an *.on.boat.dev " +
      "host: Vite needs `server.allowedHosts: true` (or `.on.boat.dev`). Not for ports 22, 6080, 8090, 8911 or 47984-48010. " +
      "The returned URL is public while the box runs: do not show servers that expose secrets.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "The port the server listens on, e.g. 3000." },
        title: { type: "string", description: 'Optional: a short name for the list, e.g. "Web app". Defaults to the port.' },
        localhost: { type: "boolean", description: "Optional: true when the server listens only on 127.0.0.1 or ::1." },
      },
      required: ["port"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    async run(args, sock) {
      const port = args.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError("`port` must be an integer from 1 to 65535.");
      if (args.title !== undefined && typeof args.title !== "string") throw new ToolError("`title` must be a string.");
      const shown = await rpcCall<ShownPreview>(sock, "preview.show", { port, title: args.title, localhost: args.localhost === true });
      return `Showing port ${shown.port} in the user's Artifacts at ${shown.url}. If the page is blank or errors, check that the server answers on that port.`;
    },
  },
  {
    name: "screenshot_share",
    title: "Show the user a screenshot",
    description:
      "Take a screenshot and show it to the user in the chat. Use it to prove visual work: after you build or change anything the user " +
      "can see (a page, a component, a layout, a style), screenshot the result and share it. Give exactly one source: " +
      "`url` renders a page in headless Chrome (best for your dev server: crisp, at `scale` 2 by default, sized by `width`/`height`); " +
      "`path` shares a PNG/JPEG/WebP you already made (e.g. a Playwright `page.screenshot` cropped to the element, or a before/after); " +
      "neither captures the whole desktop the user watches in the Computer tab. You get the image back to check it: if it is blank, " +
      "half-loaded, cropped wrong or shows an error, fix that and share again. The result contains a markdown line; put it in your final " +
      "answer so the user sees the image there.",
    inputSchema: {
      type: "object",
      properties: {
        caption: { type: "string", description: 'What the image shows, in a few words, e.g. "Settings page, dark theme".' },
        url: { type: "string", description: "A page to render, e.g. http://localhost:3000/settings." },
        path: { type: "string", description: "An image file to share instead (PNG, JPEG, WebP or GIF, at most 8 MB)." },
        width: { type: "integer", minimum: 320, maximum: 3840, description: "With `url`: viewport width in CSS pixels. Default 1440; 390 for a phone." },
        height: { type: "integer", minimum: 240, maximum: 4000, description: "With `url`: viewport height in CSS pixels. Default 900." },
        scale: { type: "number", minimum: 1, maximum: 3, description: "With `url`: device pixel ratio. Default 2 (sharp text)." },
        dark: { type: "boolean", description: "With `url`: render with prefers-color-scheme: dark." },
      },
      required: ["caption"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const caption = typeof args.caption === "string" ? args.caption.trim() : "";
      if (!caption) throw new ToolError("`caption` must say what the image shows.");
      if (args.url !== undefined && args.path !== undefined) throw new ToolError("Give `url` or `path`, not both.");
      const bytes = typeof args.path === "string" ? readImage(args.path) : typeof args.url === "string" ? await renderPage(args.url, args) : await captureDesktop();
      if (!sniff(bytes)) throw new ToolError("That is not a PNG, JPEG, WebP or GIF image.");
      if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError(`The image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 8 MB. Crop it or use a smaller scale.`);
      const data = bytes.toString("base64");
      const shared = await rpcCall<{ id: string; width?: number; height?: number }>(sock, "image.share", { data, caption });
      const alt = caption.replace(/[\[\]\n]/g, " ");
      const size = shared.width && shared.height ? ` (${shared.width}x${shared.height})` : "";
      const content: Content[] = [{ type: "text", text: `Shared${size}. The user sees it once you put this line in your final answer:\n\n![${alt}](dorks-image:${shared.id})` }];
      // Hand the image back so the agent can judge it; above this size it would cost too much context.
      if (bytes.length <= 3.5 * 1048576) content.push({ type: "image", data, mimeType: sniff(bytes)! });
      return content;
    },
  },
  // ---- local_*: the owner's own computer (docs/local-access.md). A session's first call asks the owner whether it may access their
  // computer (for this session, or always) and waits for the answer; once allowed, calls run right away. Each returns the result.
  {
    name: "local_run",
    title: "Run a command on the user's computer",
    description:
      "Ask the user to run one shell command on their own computer (not this sandbox) and get its output. Use it only for what exists there " +
      "and not here: a CLI signed in to their accounts, a local-only service, their simulators or devices, files outside this repo. The first " +
      "local_run or local_read of this session asks the user, with your `reason`, whether you may access their computer, and waits for their " +
      "answer (up to 5 minutes, then use local_wait); once they allow it, later calls run without asking, but every command is in their chat. " +
      "One request at a time. Runs non-interactively in their login shell (stdin closed, no TTY), so pass flags that skip prompts. Prefer " +
      "read-only commands; never ask for secrets, keychains or credential files, and never to delete or change things unless the user asked " +
      "for exactly that. If they decline, do not ask again in this turn.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The exact shell command, e.g. `xcrun simctl list devices booted`. Shown to the user verbatim." },
        cwd: { type: "string", description: "Optional: the folder to run in, absolute or starting with ~/. Default: the user's home folder." },
        reason: { type: "string", description: "One sentence for the user: why you need this and what you will do with the output." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "Optional: stop it after this many seconds. Default 120." },
      },
      required: ["command", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
    async run(args, sock) {
      if (typeof args.command !== "string" || !args.command.trim()) throw new ToolError("`command` is required.");
      if (typeof args.reason !== "string" || !args.reason.trim()) throw new ToolError("`reason` must tell the user why you need it.");
      return askLocal(sock, { kind: "run", command: args.command, cwd: args.cwd, reason: args.reason, timeoutSeconds: args.timeoutSeconds });
    },
  },
  {
    name: "local_read",
    title: "Read a file on the user's computer",
    description:
      "Ask the user to let you read one text file on their own computer (not this sandbox), e.g. a local config, a log, a file they mentioned " +
      "that is not in the repo. Like local_run, the session's first request asks the user for access to their computer and waits; at most " +
      "256 KB of text. Never ask for keys, tokens, keychains or other credentials.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, absolute or starting with ~/, e.g. ~/Library/Logs/MyApp/app.log." },
        reason: { type: "string", description: "One sentence for the user: why you need it." },
      },
      required: ["path", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    async run(args, sock) {
      if (typeof args.path !== "string" || !args.path.trim()) throw new ToolError("`path` is required.");
      if (typeof args.reason !== "string" || !args.reason.trim()) throw new ToolError("`reason` must tell the user why you need it.");
      return askLocal(sock, { kind: "read", path: args.path, reason: args.reason });
    },
  },
  {
    name: "local_wait",
    title: "Keep waiting for a request on the user's computer",
    description:
      "Keep waiting for a local_run or local_read request that was still waiting for the user (or still running) when that call returned. " +
      "Waits up to 5 more minutes and returns the answer and the result. A request the user did not answer expires 10 minutes after you asked.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string", description: "The request id the earlier call returned." } },
      required: ["requestId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.requestId !== "string" || !args.requestId) throw new ToolError("`requestId` is required.");
      return waitLocal(sock, args.requestId);
    },
  },
  // ---- machine_*: the build this session's machine starts from (docs/builds.md). Deferred like every MCP tool, so a session that never
  // touches its machine pays only for these names. The server scopes every call to this dork's own build and never returns a secret.
  {
    name: "machine_get",
    title: "Read this session's machine (build)",
    description:
      "Machine setup: what the build this session's machine starts from installs and sets up for every future session: its setup script, pre-cloned " +
      "repositories (each with an optional script run in its clone), environment variables (plain values; secrets by name only), machine size, " +
      "whether its saved image is current, its last run, and your draft of changes if you have one. Start here when the user asks you to install " +
      "a tool, set a variable or pre-clone a repo for future sessions. To change it: try the commands in this box first, then machine_draft, " +
      "machine_run (a trial), machine_logs, and machine_submit for the owner's approval.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(_args, sock) {
      const r = await rpcCall<{ build: MachineBuild | null; draft: MachineDraft | null }>(sock, "build", { action: "get" });
      if (!r.build)
        return (
          "This session runs on the base machine, not on a build. To set one up, propose a new build: machine_draft (give it a `name`) " +
          "creates it with your draft and moves this session onto it; then machine_run (trial), machine_logs and machine_submit as usual. " +
          "Nothing can be built from it until the owner approves; if they reject it, it is deleted and this session is back on the base machine."
        );
      return describeBuild(r.build, r.draft);
    },
  },
  {
    name: "machine_draft",
    title: "Draft a change to this session's machine",
    description:
      "Machine setup: write your proposed change to this session's build. Nothing changes for the owner until they approve it (machine_submit). Fields you " +
      "leave out keep their current value. `setupScript` is the whole bash script (run with `bash -e` as `user`, passwordless sudo, in /home/user, at build " +
      "time only, never at session start): write it idempotent and non-interactive, e.g. `sudo apt-get install -y ...`. `repos` is the whole list; each is " +
      "cloned to ~/work/<owner>/<name>, and its `setupScript` runs inside the clone (e.g. `pnpm install`). `vars` changes variables: a plain one may carry " +
      "`value`; for a secret give only the name and why, never a value (the owner types it in). Set `buildTime` only when the setup script needs the " +
      "value; every variable reaches future sessions' environment anyway. Then run it with machine_run. A submitted draft cannot change until the owner decides. " +
      "On the base machine (no build yet) this proposes a new build named `name` and moves this session onto it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Only on the base machine: the name of the build you propose. Default: the session's repository name." },
        setupScript: { type: "string", description: "The full setup script (bash). Replaces the draft's script." },
        repos: {
          type: "array",
          description: "The full list of repositories to pre-clone. Replaces the draft's list.",
          items: {
            type: "object",
            properties: {
              repo: { type: "string", description: "owner/name on GitHub." },
              branch: { type: "string", description: "Optional: the branch to clone instead of the default one." },
              setupScript: { type: "string", description: "Optional: bash run inside the clone at build time, e.g. `pnpm install`." },
            },
            required: ["repo"],
            additionalProperties: false,
          },
        },
        machineType: { type: "string", enum: ["small", "default", "large", "xlarge"], description: "Machine size: small 2 CPU/4 GB, default 4/8, large 8/16, xlarge 16/32." },
        vars: {
          type: "array",
          description: "Variable changes, merged into the draft by name.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "UPPER_SNAKE_CASE." },
              value: { type: "string", description: "Plain variables only." },
              secret: { type: "boolean", description: "True for keys, tokens, passwords: the owner fills in the value." },
              buildTime: { type: "boolean", description: "True when the setup script needs it." },
              why: { type: "string", description: "What it is for, shown to the owner." },
              remove: { type: "boolean", description: "True to delete the variable." },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const d = await rpcCall<MachineDraft>(sock, "build", { action: "draft", draft: args });
      return `Draft saved.\n\n${describeDraft(d)}\n\nNext: machine_run with kind "trial" to check that it builds.`;
    },
  },
  {
    name: "machine_run",
    title: "Run this session's machine build",
    description:
      "Machine setup: start a run of this session's build in a fresh, throwaway machine. `trial` (the default) runs your draft (or the build as it is) " +
      "without saving anything and without secrets: use it to check your setup script works. `image` rebuilds and saves the build's image, and is only " +
      "allowed for the spec the owner approved (for example after the base was updated); to change the build, submit your draft instead. Returns at " +
      "once; follow it with machine_logs and `wait`. A run takes a few minutes; trials are limited per day.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["trial", "image"], description: "Default: trial." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, sock) {
      const run = await rpcCall<MachineRun>(sock, "build", { action: "run", kind: args.kind });
      return `Started ${run.kind === "image" ? "an image" : "a trial"} run (${run.id}). Follow it with machine_logs { "wait": 120 }.`;
    },
  },
  {
    name: "machine_logs",
    title: "Read a machine build's logs",
    description:
      "Machine setup: the status and output of this session's latest build run (or `runId`). `wait` (seconds, up to 120) waits for the run to end " +
      "first, so you do not need a sleep loop; call again if it is still running. `tail` lines (default 200) or `grep` (a plain substring) narrow the " +
      "output. Secrets are shown as [redacted]. When a run fails, fix the cause in your draft and run a trial again.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Optional: a run id from machine_run. Default: the latest run." },
        wait: { type: "integer", minimum: 0, maximum: 120, description: "Seconds to wait for the run to finish." },
        tail: { type: "integer", minimum: 1, maximum: 5000, description: "Lines from the end. Default 200." },
        grep: { type: "string", description: "Only lines containing this text (case-insensitive)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const wait = typeof args.wait === "number" ? Math.min(Math.max(args.wait, 0), 120) * 1000 : 0;
      const deadline = Date.now() + wait;
      const ask = () => rpcCall<{ run: MachineRun; log: string }>(sock, "build", { action: "logs", runId: args.runId, tail: args.tail, grep: args.grep });
      let r = await ask();
      while ((r.run.status === "queued" || r.run.status === "running") && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, Math.min(5_000, Math.max(0, deadline - Date.now()))));
        r = await ask();
      }
      return `${describeRun(r.run)}\n\n${r.log.trim() ? r.log : "(no output yet)"}`;
    },
  },
  {
    name: "machine_submit",
    title: "Submit the machine draft for approval",
    description:
      "Machine setup: ask the owner to approve your draft. They see a diff card in this chat and on the build's page; once approved, the draft becomes " +
      "the build and its image is rebuilt (follow it with machine_logs). Submit only after a trial run succeeded. Their answer arrives as your next " +
      "turn. `note`: one or two sentences on what changes and why.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "What the change does and why, for the owner." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      await rpcCall(sock, "build", { action: "submit", note: args.note });
      return "Submitted. The owner decides in the app; their answer arrives as your next turn. Do not keep polling for it.";
    },
  },
];

// ---- local_*: ask, then wait in short polls (the backend answers each within 8 s) until the owner answered and it finished.
const LOCAL_WAIT_MS = 5 * 60_000;
type LocalResult = {
  requestId: string;
  kind: "run" | "read";
  status: "pending" | "running" | "denied" | "expired" | "done" | "failed";
  exitCode?: number | null;
  output?: string;
  truncated?: boolean;
  error?: string;
};

async function askLocal(sock: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpcCall<LocalResult>(sock, "local", { action: "request", ...args });
  return waitLocal(sock, r.requestId, r);
}

async function waitLocal(sock: string, requestId: string, first?: LocalResult): Promise<string> {
  const deadline = Date.now() + LOCAL_WAIT_MS;
  let r = first;
  while (!r || ((r.status === "pending" || r.status === "running") && Date.now() < deadline)) {
    r = await rpcCall<LocalResult>(sock, "local", { action: "wait", requestId, waitMs: 8_000 });
  }
  return describeLocal(r);
}

export function describeLocal(r: LocalResult): string {
  const kind = r.kind;
  const id = `(request ${r.requestId})`;
  switch (r.status) {
    case "pending":
      return `Still waiting for the user to answer ${id}. Call local_wait with this requestId to keep waiting, or carry on without it. Do not ask again meanwhile.`;
    case "running":
      return `The user allowed it and it is still running ${id}. Call local_wait with this requestId for the result.`;
    case "denied":
      return `The user declined access to their computer ${id}. Do not ask again in this turn: continue without it, or say in your final answer what they could run themselves.`;
    case "expired":
      return `The user did not answer in time ${id}. Continue without it, or ask in your final answer.`;
  }
  const body = r.output ?? "";
  const cut = r.truncated ? (kind === "read" ? "\n\n[Only the first 256 KB of the file.]" : "\n\n[The middle of the output was cut.]") : "";
  if (kind === "read") return r.status === "done" ? body + cut : `Could not read it: ${r.error ?? "unknown error"}`;
  const head = r.error ? `${r.error}${r.exitCode != null ? ` Exit code ${r.exitCode}.` : ""}` : `Exit code ${r.exitCode ?? "unknown"}.`;
  return body.trim() ? `${head}\n\n${body}${cut}` : `${head} No output.`;
}

type MachineRun = { id: string; kind: string; status: string; step: string | null; error: string | null; exitCode: number | null; startedBy: string; createdAt: number; finishedAt: number | null };
type MachineVar = { name: string; secret: boolean; buildTime: boolean; value?: string; requested: boolean };
type MachineRepo = { repo: string; branch?: string; setupScript?: string };
type MachineSpec = { machineType: string; setupScript: string; repos: MachineRepo[]; buildTimeVars: string[] };
type MachineBuild = {
  name: string;
  machineType: string;
  setupScript: string;
  repos: MachineRepo[];
  vars: MachineVar[];
  approved: boolean;
  image: { stale: boolean; staleReason: string | null } | null;
  lastRun: MachineRun | null;
};
type MachineDraft = {
  status: string;
  spec: MachineSpec;
  vars: { name: string; secret: boolean; buildTime: boolean; value?: string; remove?: boolean; why: string }[];
  stale: boolean;
  note: string | null;
};

const script = (s: string | undefined) => (s?.trim() ? "```bash\n" + s.trim() + "\n```" : "(none)");
const repoLines = (repos: MachineRepo[]) =>
  repos.length
    ? repos.map((r) => `- ${r.repo}${r.branch ? ` (branch ${r.branch})` : ""}${r.setupScript?.trim() ? `\n  setup:\n${script(r.setupScript).replace(/^/gm, "  ")}` : ""}`).join("\n")
    : "(none)";

function describeRun(r: MachineRun): string {
  const what = `${r.kind} run ${r.id}: ${r.status}${r.step && r.status === "running" ? ` (${r.step})` : ""}`;
  return r.error ? `${what}\n${r.error}` : what;
}

function describeBuild(b: MachineBuild, d: MachineDraft | null): string {
  const vars = b.vars.length
    ? b.vars
        .map(
          (v) =>
            `- ${v.name}${v.secret ? " (secret" + (v.requested ? ", waiting for the owner)" : ")") : v.requested ? " (waiting for a value)" : `=${v.value ?? ""}`}${v.buildTime ? " [build time]" : ""}`,
        )
        .join("\n")
    : "(none)";
  const image = !b.image ? "not built yet" : b.image.stale ? `stale: ${b.image.staleReason}` : "current";
  return [
    `Build "${b.name}", size ${b.machineType}, image ${image}.`,
    `Setup script:\n${script(b.setupScript)}`,
    `Repositories:\n${repoLines(b.repos)}`,
    `Variables:\n${vars}`,
    `Last run: ${b.lastRun ? describeRun(b.lastRun) : "none"}`,
    d ? `Your draft:\n${describeDraft(d)}` : "You have no draft.",
  ].join("\n\n");
}

function describeDraft(d: MachineDraft): string {
  const vars = d.vars.length
    ? d.vars
        .map((v) => `- ${v.remove ? "remove " : ""}${v.name}${v.secret ? " (secret, owner fills it in)" : v.value !== undefined ? `=${v.value}` : ""}${v.buildTime ? " [build time]" : ""}`)
        .join("\n")
    : "(no variable changes)";
  return [
    `Status: ${d.status}${d.stale ? " (the build changed since you started this draft: check it with machine_get)" : ""}. Size ${d.spec.machineType}.`,
    `Setup script:\n${script(d.spec.setupScript)}`,
    `Repositories:\n${repoLines(d.spec.repos)}`,
    `Variable changes:\n${vars}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------- screenshots (screenshot_share)

const run = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 45_000;

function sniff(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return null;
}

function readImage(path: string): Buffer {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new ToolError(`No file at ${path}.`);
  }
  if (!st.isFile()) throw new ToolError(`${path} is not a file.`);
  if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`${path} is ${(st.size / 1048576).toFixed(1)} MB; the limit is 8 MB.`);
  return readFileSync(path);
}

const CHROMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Browsers Playwright downloaded (`npx playwright install`), newest first: the headless shell is made for exactly this. */
function playwrightChromes(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  const found: string[] = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const rel of [
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-linux/chrome",
        "chrome-linux64/chrome",
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ])
        if (existsSync(join(root, d, rel))) found.push(join(root, d, rel));
    }
  }
  return found;
}

async function findChrome(): Promise<string> {
  for (const c of CHROMES) {
    if (c.startsWith("/")) {
      if (existsSync(c)) return c;
    } else if (
      await run("which", [c]).then(
        () => true,
        () => false,
      )
    )
      return c;
  }
  const pw = playwrightChromes()[0];
  if (pw) return pw;
  throw new ToolError("No Chrome or Chromium found for `url`. Take the screenshot yourself (e.g. Playwright) and pass `path`.");
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** One page in a throwaway headless Chrome profile, so it never fights the desktop Chrome the user watches over its profile lock. */
async function renderPage(url: string, args: Record<string, unknown>): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must start with http:// or https://.");
  const chrome = await findChrome();
  const dir = mkdtempSync(join(tmpdir(), "dorks-shot-"));
  const out = join(dir, "shot.png");
  const width = Math.round(num(args.width, 1440, 320, 3840));
  const height = Math.round(num(args.height, 900, 240, 4000));
  const scale = num(args.scale, 2, 1, 3);
  try {
    await run(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        `--user-data-dir=${join(dir, "profile")}`,
        `--window-size=${width},${height}`,
        `--force-device-scale-factor=${scale}`,
        ...(args.dark === true ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : ["--blink-settings=preferredColorScheme=1"]),
        "--virtual-time-budget=8000", // let scripts, fonts and data settle before the shot
        `--screenshot=${out}`,
        url,
      ],
      { timeout: CAPTURE_TIMEOUT_MS },
    );
    if (!existsSync(out)) throw new ToolError(`Chrome did not write a screenshot of ${url}. Check that it answers (curl -sI ${url}).`);
    return readFileSync(out);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      `Chrome could not screenshot ${url}: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message)
        .trim()
        .slice(-400)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The whole Boat desktop (Xorg :0), the screen the owner watches in the Computer tab. */
async function captureDesktop(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "dorks-shot-"));
  const out = join(dir, "desktop.png");
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":0" };
  try {
    await run("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-i", env.DISPLAY, "-frames:v", "1", out], { timeout: CAPTURE_TIMEOUT_MS, env }).catch(() =>
      run("import", ["-window", "root", out], { timeout: CAPTURE_TIMEOUT_MS, env }),
    );
    if (!existsSync(out)) throw new Error("no file");
    return readFileSync(out);
  } catch {
    throw new ToolError("Could not capture the desktop here (no X display). Pass `url` for a page or `path` for an image file.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const byName = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- crew tools (docs/crew.md)
// Listed only for a coordinator or worker dork (the bridge answers `crew.role` from its configure). The table and the result text are
// shared with the server's external MCP endpoint (packages/shared/src/crew.ts); the server scopes every call to this dork's crew.

const crewTools = (role: CrewRole | null) => (role ? crewToolsFor(role).map(({ audience: _a, ...t }) => t) : []);

async function runCrew(sock: string, name: string, args: Record<string, unknown>): Promise<string> {
  const call = (a: Record<string, unknown>) => rpcCall<CrewResult>(sock, "crew", { tool: name, args: a });
  if (name !== "dork_wait") return renderCrew(await call(args));
  // One server call waits at most CREW_WAIT_SLICE_MS; repeat until something settles or the agent's own timeout is up.
  const secs = typeof args.timeoutSeconds === "number" && args.timeoutSeconds > 0 ? Math.min(args.timeoutSeconds, MAX_WAIT_SECONDS) : 120;
  const deadline = Date.now() + secs * 1000;
  for (;;) {
    const r = await call({ ...args, timeoutSeconds: Math.max(1, Math.min(CREW_WAIT_SLICE_MS, deadline - Date.now()) / 1000) });
    if (r.tool !== "dork_wait" || !r.timedOut || Date.now() >= deadline - 500) return renderCrew(r);
  }
}

type Id = string | number | null;
interface Request {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export class McpServer {
  private role: Promise<CrewRole | null> | null = null;
  constructor(private env: NodeJS.ProcessEnv) {}

  /** The dork's crew role, asked of the bridge once per MCP session (none outside a box or on an older bridge). */
  private crewRole(): Promise<CrewRole | null> {
    const sock = socketOf(this.env);
    this.role ??= sock
      ? rpcCall<{ role: CrewRole | null }>(sock, "crew.role").then(
          (r) => r?.role ?? null,
          () => null,
        )
      : Promise.resolve(null);
    return this.role;
  }

  /** One incoming message. Returns the reply, or null for notifications (which are never answered). */
  async handle(line: string): Promise<object | null> {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return err(null, -32700, "parse error");
    }
    if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") return err(null, -32600, "invalid request");
    const isNotification = !("id" in req);
    const id = req.id ?? null;
    const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
    let reply: object;
    switch (req.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        reply = ok(id, {
          protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "Dorks", version: "0.1.0" },
          instructions:
            "Tools for the pull requests you work on in this box, and for showing the user your work. `gh pr create` subscribes you automatically; subscribed PRs wake you with <dorks-event> turns when CI, reviews, comments or conflicts need you. " +
            "When you start a web server the user should see, call preview_show with its port. When you change anything visual, verify it with screenshot_share and put the image it returns in your final answer. " +
            "To install tools, set variables or pre-clone repos for future sessions, search for the machine_ tools. " +
            "In a crew (a coordinator and its worker dorks), the dork_ tools start, message and follow the other dorks.",
        });
        break;
      }
      case "ping":
        reply = ok(id, {});
        break;
      case "tools/list":
        reply = ok(id, { tools: [...TOOLS.map(({ run: _run, ...t }) => t), ...crewTools(await this.crewRole())] });
        break;
      case "tools/call":
        reply = ok(id, await this.call(params.name, params.arguments));
        break;
      default:
        reply = err(id, -32601, "method not found");
    }
    return isNotification ? null : reply;
  }

  private async call(name: unknown, args: unknown) {
    const crew = typeof name === "string" && crewTools(await this.crewRole()).some((t) => t.name === name);
    const tool = typeof name === "string" ? byName.get(name) : undefined;
    const result = (out: string | Content[], isError = false) => ({ content: typeof out === "string" ? [{ type: "text", text: out }] : out, isError });
    if (!tool && !crew) return result(`Unknown tool "${String(name)}".`, true);
    const sock = socketOf(this.env);
    if (!sock) return result("This only works inside a dork box (DORKS_SOCK is not set).", true);
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    try {
      return result(crew ? await runCrew(sock, name as string, a) : await tool!.run(a, sock));
    } catch (e) {
      return result(e instanceof ToolError ? e.message : describeRpcError(e), true);
    }
  }
}

/** Serves one MCP session on a stream pair until the input ends (Claude Code closes our stdin when it exits). */
export function serveMcp(env: NodeJS.ProcessEnv, input: NodeJS.ReadableStream, write: (s: string) => void): Promise<void> {
  const server = new McpServer(env);
  let chain: Promise<unknown> = Promise.resolve(); // answered in arrival order
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      const reply = await server.handle(line).catch(() => err(null, -32603, "internal error"));
      if (reply) write(JSON.stringify(reply) + "\n");
    });
  });
  return new Promise((resolve) => rl.on("close", () => void chain.then(() => resolve())));
}
