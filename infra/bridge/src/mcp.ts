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
import type { ServiceStatus } from "./services";
import { SKILLS, skillEntry, skillFileByUri } from "./mcp-skills";
import { rpcCall } from "./rpc";
import { describeAb, describeTelemetry, PlanError, runAb } from "./prodlike";

// `dorks mcp`: the same agent surface as `dorks pr …`, as MCP tools (Model Context Protocol) so the agent calls them as typed tools
// instead of shelling out. It is a stdio MCP server: Claude Code starts it from the bridge-written `mcp.json` (hooks.ts `claudeMcpConfig`,
// passed as `claude --mcp-config`), speaks newline-delimited JSON-RPC 2.0 to it, and it forwards every call to the running bridge on
// DORKS_SOCK. Nothing here holds state or a credential; the backend stays the single owner of the truth.
//
// Hand-rolled on purpose: the bridge ships as one dependency-light bundle and the server needs a handful of methods, so the MCP SDK would
// only add weight to every box snapshot.
//
// Dual-era (MCP 2026-07-28, "Versioning: Backward Compatibility"): a request carrying `_meta["io.modelcontextprotocol/protocolVersion"]`
// is served statelessly by the modern revision (`server/discover`, `resultType`, cache hints, the Skills extension's `skills/list` and
// `skills/get`); an `initialize` handshake gets the legacy revisions, as Codex and older Claude Code speak them. Both eras list the same
// tools and serve the same skill files as resources.

/** The server name; Claude Code prefixes the tools with it, so the agent sees `mcp__dorks__pr_subscribe`. */
export const MCP_SERVER_NAME = "dorks";
/** Modern versions: no handshake, every request names its version in `_meta`. Another one is refused with the list (-32022). */
const MODERN_VERSIONS = ["2026-07-28"];
/** Legacy versions, negotiated by `initialize`. A client asking for another one is answered with the newest, as those revisions require. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SERVER_INFO = { name: MCP_SERVER_NAME, title: "Dorks", version: "0.2.0" };
/** Modern cache hints. Tools and skills are fixed for the life of this process (a mode switch restarts it), but they are this dork's own. */
const CACHE = { ttlMs: 60 * 60_000, cacheScope: "private" } as const;
const UNSUPPORTED_VERSION = -32022;
const INVALID_PARAMS = -32602;

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

type ServiceLine = ServiceStatus;
const serviceLine = (s: ServiceLine) =>
  `- ${s.name}: ${s.state}${s.port ? `, port ${s.port}` : ""}${s.preview ? " (UI, opens as a preview)" : ""}${s.source === "adhoc" ? " (started ad hoc)" : ""}. ` +
  `\`${s.command}\` in ${s.cwd}, log ${s.log}${s.url ? `, preview ${s.url}` : ""}`;

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
      "(`--host 0.0.0.0`); pass `localhost: true` only for one that listens on 127.0.0.1 alone. The page reaches your server through a " +
      "proxy that makes every request look local (Host localhost:<port>), so no allowedHosts setting is needed; it adds the user's " +
      "element picker to HTML pages and passes WebSockets (HMR) through. Not for ports 22, 6080, 8090, 8911 or 47984-48010. " +
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
  // Services (docs/services.md): the build's dev servers and backing services, prebuilt and warmed in its image, started on demand.
  {
    name: "service_list",
    title: "List this box's services",
    description:
      "The dev servers and backing services this session's machine has ready to start (prebuilt and warmed in its image, never running at boot), plus any you started with service_start, " +
      "each with its command, directory, port, state and log file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(_args, sock) {
      const r = await rpcCall<{ services: ServiceLine[] }>(sock, "service", { action: "list" });
      if (!r.services.length)
        return "This machine defines no services. Start a server with service_start (name, command, port) to have it managed here; propose it for future sessions with machine_draft `services`.";
      return r.services.map(serviceLine).join("\n");
    },
  },
  {
    name: "service_start",
    title: "Start a dev server or service",
    description:
      "Start one of this machine's services by name (see service_list) and wait until it listens on its port, so you can test your change against it at once. " +
      "A service marked as a UI opens in the user's Artifacts as a running preview. Already running: returns at once (pass `restart: true` after a change it does not hot-reload). " +
      "To run any other server the same way, give a new `name` with its `command`, `port` and `cwd` (under ~/work): it runs in the background as you, in its own process group, " +
      "with your environment, its output in a log file. Then exercise what you changed against it for real: curl the endpoints, open the page and screenshot it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The service's name, e.g. web." },
        command: { type: "string", description: "Only for a service the machine does not define: the shell command, e.g. `pnpm dev --host 0.0.0.0 --port 5173`." },
        cwd: { type: "string", description: "Only with `command`: the directory under ~/work, e.g. acme/shop/apps/web. Default: ~/work." },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Only with `command`: the port it listens on; the start waits for it." },
        preview: { type: "boolean", description: "Only with `command`: show it to the user as a running preview once it listens." },
        restart: { type: "boolean", description: "Stop it first if it runs." },
        waitSeconds: { type: "integer", minimum: 1, maximum: 600, description: "How long to wait for the port. Default 120." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.name !== "string" || !args.name) throw new ToolError("`name` is required.");
      // The bridge answers once the port listens: wait as long as the start may, plus a restart's stop and some slack.
      const waitS = typeof args.waitSeconds === "number" && args.waitSeconds > 0 ? Math.min(args.waitSeconds, 600) : 120;
      const r = await rpcCall<ServiceLine & { already: boolean; tail: string }>(sock, "service", { action: "start", ...args }, (waitS + 30) * 1000);
      const head =
        r.state === "running"
          ? `${r.name} is ${r.already ? "already running" : `up in ${((r.readyMs ?? 0) / 1000).toFixed(1)} s`}${r.port ? ` on port ${r.port}` : ""}.${r.url ? ` Showing it in the user's Artifacts at ${r.url}.` : ""}`
          : r.state === "starting"
            ? `${r.name} is still starting: nothing listens on port ${r.port} yet. Check service_logs, then call service_start again to keep waiting.`
            : `${r.name} exited${r.exitCode !== null ? ` with code ${r.exitCode}` : ""} before it was ready.`;
      return `${head}\nLog: ${r.log}${r.tail.trim() ? `\nLast output:\n${r.tail.trimEnd()}` : ""}`;
    },
  },
  {
    name: "service_logs",
    title: "Read a service's output",
    description: "The last lines of a service's output (its log file, which you can also read or tail yourself).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 2000, description: "Default 100." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const r = await rpcCall<{ name: string; log: string; text: string }>(sock, "service", { action: "logs", name: args.name, lines: args.lines });
      return r.text.trim() ? `${r.log}:\n${r.text.trimEnd()}` : `${r.name} has no output yet (${r.log}).`;
    },
  },
  {
    name: "service_stop",
    title: "Stop a service",
    description: "Stop a running service and everything it started (its whole process group).",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    async run(args, sock) {
      const r = await rpcCall<ServiceLine>(sock, "service", { action: "stop", name: args.name }, 30_000);
      return `${r.name} is stopped.`;
    },
  },
  // Preview comments (docs/architecture.md, "Preview comments"): the user's threads on the running preview. They arrive as
  // <dorks-event source="preview"> turns; these answer and close them.
  {
    name: "comment_list",
    title: "Read the user's comments on the preview",
    description:
      "The user's comment threads on the running preview, each with its id, where it points (the page path, the element or the quoted text, " +
      "and the React component and source file when the page is a dev build) and every message in it. Open threads only unless `all` is true.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Optional: include resolved threads." } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      const r = await rpcCall<{ text: string }>(sock, "comment", { action: "list", all: args.all === true });
      return r.text;
    },
  },
  {
    name: "ship_verify",
    title: "Report whether a merged PR works in production",
    description:
      "Answer a `deployed` notification: after one of your merged PRs went live, you opened the live URL and exercised exactly what the PR " +
      "changed. Report `ok` (it works there) or not, with a one or two sentence `note` of what you checked and saw. The user sees it on the " +
      "PR's ship card. When it does not work, also open a fix-forward PR (or a revert PR); never deploy or roll back yourself.",
    inputSchema: {
      type: "object",
      properties: {
        pr: { ...PR_PARAM, description: "The merged pull request you checked (from the `deployed` notification). " + PR_PARAM.description },
        ok: { type: "boolean", description: "Whether the change works on the live deployment." },
        note: { type: "string", description: "What you checked and what you saw, in one or two sentences." },
      },
      required: ["pr", "ok", "note"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.ok !== "boolean" || typeof args.note !== "string" || !args.note.trim()) throw new ToolError("`ok` and a non-empty `note` are required.");
      const ref = prArg(args);
      const r = await rpcCall<{ text: string }>(sock, "ship", { action: "verify", ...ref, ok: args.ok, note: args.note });
      return r.text;
    },
  },
  // ---- the Twin Engine, prod-like testing (cloud sessions on a Teams or Cloud plan): this box's own telemetry, and the A/B run behind the PR check.
  {
    name: "telemetry_query",
    title: "Query this box's errors, spans and p95 (Sentry)",
    description:
      "Twin Engine: read the telemetry your box's services send to Sentry. Services started in this box get SENTRY_DSN and " +
      "SENTRY_ENVIRONMENT (this box's own environment) in their environment; an app with any Sentry SDK reports there by itself. You " +
      "only ever see this box's events. kind errors: error groups; spans: operations (db queries, http calls) with count and p95; p95: " +
      "per route (requests, p95 ms, failure rate, queries per request); usage: spans sent this hour against the box's budget. " +
      "`half` reads one half of your last prodlike_run instead (base or head).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["errors", "spans", "p95", "usage"], description: "Default: errors." },
        route: { type: "string", description: 'Optional: one route, as Sentry names it, e.g. "GET /customers/:id".' },
        op: { type: "string", description: 'Optional, spans only: an operation, e.g. "db" or "http.client".' },
        since: { type: "string", description: "Optional: how far back, like 15m, 1h (default) or 2d." },
        half: { type: "string", enum: ["base", "head"], description: "Optional: a half of the last prodlike_run." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Rows, default 20." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      return describeTelemetry(await rpcCall(sock, "telemetry", { kind: args.kind ?? "errors", ...args }, 30_000));
    },
  },
  {
    name: "prodlike_run",
    title: "A/B the PR's base and head on this box (the Twin Engine check)",
    description:
      "Twin Engine: run your PR's base commit and its head commit on this box, one after the other, against the same database " +
      "branch, with the same load (the repository's .dorks/load scripts, GET and HEAD only unless the team allows writes), and compare " +
      'new error groups, error rate, queries per request and p95 per route. The result is posted as the "Dorks / Twin Engine" check on ' +
      "the head commit and returned here. Needs .dorks/prodlike.json (the service to start, how to set it up, the load scripts); if it " +
      "is missing, the error says what to write. Commit first: the run tests the committed HEAD. Takes a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        rounds: { type: "integer", minimum: 1, maximum: 10, description: "Rounds per half (default from .dorks/prodlike.json, else 3). p95 fails only when slower in 3 or more." },
        requests: { type: "integer", minimum: 10, maximum: 5000, description: "Requests per round (default 200; less when the span budget is short)." },
        base: { type: "string", description: "Optional: the base ref (default: the merge base with origin's default branch)." },
        dir: { type: "string", description: "Optional: the repository (default: the current directory)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, sock) {
      try {
        const r = await runAb({
          dir: typeof args.dir === "string" ? args.dir : process.cwd(),
          call: (op, a) => rpcCall(sock, op, a, 60_000),
          baseRef: typeof args.base === "string" ? args.base : undefined,
          rounds: typeof args.rounds === "number" ? args.rounds : undefined,
          requests: typeof args.requests === "number" ? args.requests : undefined,
        });
        return describeAb(r);
      } catch (e) {
        if (e instanceof PlanError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: "comment_reply",
    title: "Answer a comment on the preview",
    description:
      "Write in a comment thread on the preview: answer the user, say what you changed, or ask what they meant. The user sees it on the " +
      "page, beside the element. Use comment_resolve instead once the comment is done.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The thread's id (from the notification or comment_list)." }, body: { type: "string", description: "What to write." } },
      required: ["id", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.id !== "string" || typeof args.body !== "string" || !args.body.trim()) throw new ToolError("`id` and a non-empty `body` are required.");
      await rpcCall(sock, "comment", { action: "reply", id: args.id, body: args.body });
      return "Replied. The user sees it in the thread on the preview.";
    },
  },
  {
    name: "comment_resolve",
    title: "Resolve a comment on the preview",
    description: "Mark a comment thread on the preview as done, with an optional last message saying what you changed. The user can reopen it, " + "which notifies you again.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The thread's id." }, body: { type: "string", description: "Optional: a short note of what you changed." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.id !== "string") throw new ToolError("`id` is required.");
      await rpcCall(sock, "comment", { action: "resolve", id: args.id, ...(typeof args.body === "string" && args.body.trim() ? { body: args.body } : {}) });
      return "Resolved.";
    },
  },
  {
    name: "screenshot_share",
    title: "Show the user a screenshot",
    description:
      "Take a screenshot and show it to the user in the chat. Use it to prove visual work: after you build or change anything the user " +
      "can see (a page, component, layout, style), screenshot the result and share it. Give exactly one source: " +
      "`url` renders a page in headless Chrome (best for your dev server: crisp PNG, at `scale` 2 by default, sized by `width`/`height`); " +
      "`path` shares a PNG/JPEG/WebP you already made (e.g. a Playwright `page.screenshot` cropped to the element, or a before/after — always capture at `deviceScaleFactor: 2` and save as PNG, since Playwright defaults to 1x); " +
      "neither captures the whole desktop the user watches in the Computer tab. You get the image back to check it: if it is blank, " +
      "half-loaded, blurry, cropped wrong or shows an error, fix that and share again. The result contains a markdown line; put it in your final " +
      "answer so the user sees the image there.",
    inputSchema: {
      type: "object",
      properties: {
        caption: { type: "string", description: 'What the image shows, in a few words, e.g. "Settings page, dark theme".' },
        url: { type: "string", description: "A page to render, e.g. http://localhost:3000/settings." },
        path: { type: "string", description: "An image file to share instead (lossless PNG at deviceScaleFactor: 2 preferred; PNG, JPEG, WebP or GIF, at most 8 MB)." },
        width: { type: "integer", minimum: 320, maximum: 3840, description: "With `url`: viewport width in CSS pixels. Default 1440; 390 for a phone." },
        height: { type: "integer", minimum: 240, maximum: 4000, description: "With `url`: viewport height in CSS pixels. Default 900." },
        scale: { type: "number", minimum: 1, maximum: 3, description: "With `url`: device pixel ratio. Default 2 (sharp text; keep at 2 unless hitting the 8 MB limit)." },
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
      if (typeof args.path !== "string" && typeof args.url !== "string") {
        throw new ToolError("Give `url` (renders at 2x PNG) or `path` (an image file captured at deviceScaleFactor: 2).");
      }
      const bytes = typeof args.path === "string" ? readImage(args.path) : await renderPage(args.url as string, args);
      const mime = sniff(bytes);
      if (!mime) throw new ToolError("That is not a PNG, JPEG, WebP or GIF image.");
      if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError(`The image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 8 MB. Crop it or use a smaller scale.`);
      const data = bytes.toString("base64");
      const shared = await rpcCall<{ id: string; width?: number; height?: number }>(sock, "image.share", { data, caption });
      const alt = caption.replace(/[[\]\n]/g, " ");
      const size = shared.width && shared.height ? ` (${shared.width}x${shared.height})` : "";
      const notes: string[] = [];
      if (typeof args.path === "string") {
        if (mime === "image/jpeg") notes.push("JPEG compresses UI text; prefer lossless PNG for screenshots.");
        if (shared.width && shared.height && shared.width < 800 && shared.height < 600) {
          notes.push(`This image is small (${shared.width}x${shared.height}); if it was captured at 1x, re-capture at deviceScaleFactor: 2 for sharp text.`);
        }
      }
      const note = notes.length ? `\n\nQuality note: ${notes.join(" ")}` : "";
      const content: Content[] = [{ type: "text", text: `Shared${size}. The user sees it once you put this line in your final answer:\n\n![${alt}](dorks-image:${shared.id})${note}` }];
      // Hand the image back so the agent can judge it; above this size it would cost too much context.
      if (bytes.length <= 3.5 * 1048576) content.push({ type: "image", data, mimeType: mime });
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
  // ---- input_*: secure inputs (docs/secure-inputs.md). The user types values the agent uses without ever reading them.
  {
    name: "input_request",
    title: "Ask the user for a login, code or secret",
    description:
      "Ask the user for values you need but must not read: a login (email and password), a one-time code (2FA, SMS, email), an API key, " +
      "a card number. They get a form in their chat and type the values in; you never see them. Waits for the answer (up to 5 minutes, " +
      "then use input_wait) and returns the names you can use. Use a value by writing {{secret:NAME}} in any tool's input: in a Bash " +
      "command (it becomes a shell variable, so put it where a variable expands: bare or in double quotes, never in single quotes), in a " +
      "browser tool's text to type, in a file you write. The value is filled in as the tool runs and shown as [redacted] in anything you " +
      "read back. Never try to print, decode or send a value anywhere but where the user meant it to go. Asking again under the same " +
      "name replaces the value (a new one-time code). One request at a time; if the user dismisses it, do not ask again in this turn.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'A short title for the form, naming what you ask for, e.g. "Stripe login" or "Cloudflare API token".' },
        description: {
          type: "string",
          description: "Optional: one short sentence on what you will use it for. Leave it out when the title says it. Do not repeat it in a field.",
        },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "The values to ask for, in the order the form shows them.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "What you write in {{secret:NAME}}: a letter, then letters, digits or _ (e.g. stripe_password)." },
              label: { type: "string", description: 'The label the user sees, e.g. "Email or phone". A form with one field shows the title instead.' },
              kind: { type: "string", enum: ["text", "email", "secret", "otp"], description: "secret: masked (passwords, keys); otp: a one-time code; email; text." },
              description: { type: "string", description: 'Optional: a few words shown as the empty input\'s placeholder, e.g. "Needs Zone:Edit" or "6 digits".' },
              url: {
                type: "string",
                description: "Optional: the https page where the user gets this value (e.g. the provider's API tokens page), shown as a link. Add it whenever you know it.",
              },
              optional: { type: "boolean", description: "Optional: true when the user may leave it empty." },
            },
            required: ["name", "label", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "fields"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.title !== "string" || !args.title.trim()) throw new ToolError("`title` is required.");
      if (!Array.isArray(args.fields) || !args.fields.length) throw new ToolError("`fields` must list at least one field.");
      const r = await rpcCall<InputResult>(sock, "input", { action: "request", title: args.title, description: args.description, fields: args.fields });
      return waitInput(sock, r.requestId, r);
    },
  },
  {
    name: "input_wait",
    title: "Keep waiting for the user's secure input",
    description: "Keep waiting for an input_request that was still waiting for the user when that call returned. Waits up to 5 more minutes. A request expires 30 minutes after you asked.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string", description: "The request id the earlier call returned." } },
      required: ["requestId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async run(args, sock) {
      if (typeof args.requestId !== "string" || !args.requestId) throw new ToolError("`requestId` is required.");
      return waitInput(sock, args.requestId);
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
      "value; every variable reaches future sessions' environment anyway. `services` lists the dev servers and services sessions start to test changes (see its schema). Then run it with machine_run. A submitted draft cannot change until the owner decides. " +
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
        services: {
          type: "array",
          description:
            "The full list of dev servers and backing services (replaces the draft's list). Each is started once at build time until its port listens and its first page is requested, " +
            "which checks it and warms its caches into the image; sessions then start it on demand with service_start. Never started at boot.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Lowercase, e.g. web, api, db." },
              command: { type: "string", description: "Runs in the foreground until stopped, e.g. `pnpm dev --host 0.0.0.0 --port 5173` or `docker compose up postgres`." },
              cwd: { type: "string", description: "Directory under ~/work, e.g. acme/shop or acme/shop/apps/web. Default: ~/work." },
              port: { type: "integer", minimum: 1, maximum: 65535, description: "The port it listens on (what readiness waits for)." },
              preview: { type: "boolean", description: "A UI the user should see: shown as a running preview when started. Needs a port." },
            },
            required: ["name", "command"],
            additionalProperties: false,
          },
        },
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

type InputResult = { requestId: string; status: "pending" | "provided" | "dismissed" | "expired"; names?: string[] };

async function waitInput(sock: string, requestId: string, first?: InputResult): Promise<string> {
  const deadline = Date.now() + LOCAL_WAIT_MS;
  let r = first;
  while (!r || (r.status === "pending" && Date.now() < deadline)) r = await rpcCall<InputResult>(sock, "input", { action: "wait", requestId, waitMs: 8_000 });
  return describeInput(r);
}

export function describeInput(r: InputResult): string {
  const id = `(request ${r.requestId})`;
  switch (r.status) {
    case "pending":
      return `Still waiting for the user ${id}. Call input_wait with this requestId to keep waiting, or carry on without it. Do not ask again meanwhile.`;
    case "dismissed":
      return `The user dismissed the form ${id}. Do not ask again in this turn: continue without it, or say in your final answer what you need.`;
    case "expired":
      return `The user did not answer in time ${id}. Continue without it, or ask in your final answer.`;
  }
  const names = r.names ?? [];
  if (!names.length) return `The user submitted the form without values ${id}.`;
  return [
    `The user provided ${names.join(", ")} ${id}. You cannot read them; use them by writing these references in a tool's input:`,
    ...names.map((n) => `- {{secret:${n}}}`),
    'In Bash a reference becomes a shell variable: write it bare or in double quotes (e.g. curl -u "me:{{secret:password}}"), not in single quotes.',
  ].join("\n");
}

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
type MachineService = { name: string; command: string; cwd?: string; port?: number; preview?: boolean };
type MachineSpec = { machineType: string; setupScript: string; repos: MachineRepo[]; buildTimeVars: string[]; services?: MachineService[] };
type MachineBuild = {
  name: string;
  machineType: string;
  setupScript: string;
  repos: MachineRepo[];
  services?: MachineService[];
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

const serviceLines = (services: MachineService[] = []) =>
  services.length ? services.map((s) => `- ${s.name}: \`${s.command}\` in ~/work${s.cwd ? `/${s.cwd}` : ""}${s.port ? `, port ${s.port}` : ""}${s.preview ? " (preview)" : ""}`).join("\n") : "(none)";

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
    `Services:\n${serviceLines(b.services)}`,
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
    `Services:\n${serviceLines(d.spec.services)}`,
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

const byName = new Map(TOOLS.map((t) => [t.name, t]));

type Crew = { role: CrewRole | null };

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

/** What the agent reads about this server before it loads any tool: `instructions` in both eras. */
const INSTRUCTIONS =
  "Tools for the pull requests you work on in this box, and for showing the user your work. `gh pr create` subscribes you automatically; subscribed PRs wake you with <dorks-event> turns when CI, reviews, comments or conflicts need you. " +
  "When you need a login, a one-time code or any secret, ask with input_request and use it as {{secret:NAME}} without reading it. " +
  "When you start a web server the user should see, call preview_show with its port. When you change anything visual, verify it with screenshot_share and put the image it returns in your final answer. " +
  'The user\'s comments on a running preview arrive as <dorks-event source="preview"> turns: answer them with comment_reply or comment_resolve. ' +
  "This box starts from a build that every future session shares: when you hit a setup problem in it (a missing tool, a broken or outdated install, a missing variable or service), or the user asks to set something up for future sessions, propose a fix to the owner with the machine-setup skill (skill://machine-setup/SKILL.md) and the machine_ tools. " +
  "To test a change against a running dev server or service, start it with service_start (service_list shows what this machine has prebuilt). " +
  "In a crew (a coordinator and its worker dorks), the dork_ tools start, message and follow the other dorks.";

type Reply = { result: Record<string, unknown>; cache?: true } | { error: { code: number; message: string } };
const failure = (code: number, message: string): Reply => ({ error: { code, message } });

/** A skill's files as `resources/list` entries: its SKILL.md named and described as the skill, the rest by their path in it. */
const skillResources = (s: (typeof SKILLS)[number]) =>
  s.files.map((f) => ({
    uri: f.uri,
    name: f.uri === s.uri ? s.frontmatter.name : f.uri.slice(`skill://${s.frontmatter.name}/`.length),
    ...(f.uri === s.uri ? { description: s.frontmatter.description } : {}),
    mimeType: f.mimeType,
    size: f.size,
  }));

export class McpServer {
  private crew: Promise<Crew> | null = null;
  constructor(private env: NodeJS.ProcessEnv) {}

  /**
   * The dork's crew role, asked of the bridge once per MCP session (none outside a box or on an older bridge). A mode switch restarts
   * the agent, and with it this server.
   */
  private crewInfo(): Promise<Crew> {
    const sock = socketOf(this.env);
    const none: Crew = { role: null };
    this.crew ??= sock
      ? rpcCall<Partial<Crew>>(sock, "crew.role").then(
          (r) => ({ role: r?.role ?? null }),
          () => none,
        )
      : Promise.resolve(none);
    return this.crew;
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
    const meta = params._meta && typeof params._meta === "object" ? (params._meta as Record<string, unknown>) : {};
    // The era is per request: a modern client names its version on every one, a legacy one opened with `initialize`.
    const asked = meta[VERSION_KEY];
    const modern = asked !== undefined || req.method === "server/discover";
    if (asked !== undefined && (typeof asked !== "string" || !MODERN_VERSIONS.includes(asked))) {
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, error: { code: UNSUPPORTED_VERSION, message: "Unsupported protocol version", data: { supported: MODERN_VERSIONS, requested: asked } } };
    }
    const reply = await this.dispatch(req.method, params, modern);
    if (isNotification) return null;
    if ("error" in reply) return err(id, reply.error.code, reply.error.message);
    // Modern results carry `resultType` and the server's identity; list and read results also carry cache hints.
    if (!modern) return ok(id, reply.result);
    return ok(id, { ...reply.result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }, ...(reply.cache ? CACHE : {}) });
  }

  private async dispatch(method: string, params: Record<string, unknown>, modern: boolean): Promise<Reply> {
    switch (method) {
      case "server/discover":
        return {
          result: { supportedVersions: MODERN_VERSIONS, capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION]: {} } }, instructions: INSTRUCTIONS },
          cache: true,
        };
      case "initialize": {
        if (modern) return failure(-32601, "initialize is not part of MCP 2026-07-28: send each request with its _meta");
        const asked = params.protocolVersion;
        return {
          result: {
            protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list": {
        const { role } = await this.crewInfo();
        return { result: { tools: [...TOOLS.map(({ run: _run, ...t }) => t), ...crewTools(role)] }, cache: true };
      }
      case "tools/call":
        return { result: await this.call(params.name, params.arguments) };
      // ---- the Skills extension (mcp-skills.ts): each skill file is a resource, in both eras; skills/list and skills/get are modern only.
      case "resources/list":
        return { result: { resources: SKILLS.flatMap(skillResources) }, cache: true };
      case "resources/templates/list":
        return { result: { resourceTemplates: [] }, cache: true };
      case "resources/read": {
        const file = typeof params.uri === "string" ? skillFileByUri(params.uri) : undefined;
        if (!file) return failure(INVALID_PARAMS, `Unknown resource: ${String(params.uri)}`);
        return { result: { contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }, cache: true };
      }
      case "skills/list":
        return modern ? { result: { skills: SKILLS.map(skillEntry) }, cache: true } : failure(-32601, "method not found");
      case "skills/get": {
        if (!modern) return failure(-32601, "method not found");
        const skill = SKILLS.find((s) => s.uri === params.uri);
        return skill ? { result: { skill: skillEntry(skill) }, cache: true } : failure(INVALID_PARAMS, `Unknown skill: ${String(params.uri)}`);
      }
      default:
        return failure(-32601, "method not found");
    }
  }

  private async call(name: unknown, args: unknown) {
    const { role } = await this.crewInfo();
    const crew = typeof name === "string" && crewTools(role).some((t) => t.name === name);
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
