import { MAX_LIVE_WORKERS, type ClientEvent } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { dorkOf, dorkView, eventOf, getDork, prStateOf, type DorkKind, type DorkRow, type DorkView, type Provider } from "../data";
import { insert } from "../db";
import { append, dispatch, enqueue, MAX_MESSAGE_CHARS, patchDork, patchRuntime, setTimer } from "../lifecycle/dispatch";
import { knownModelChoices, validModelChoice, validOpenCodeModel } from "./models";
import { validRepo } from "../lib/repo";
import { isBoxNotFound, type DesktopOptions } from "../core/box";
import { missingForSession } from "./setup";
import { readSettings } from "./settings";
import { defaultBuildId, getBuild } from "./builds";
import { claimImages } from "./bridge";
import { endDorkSubscriptions, resetCiAttempts, subscriptionsOfDork } from "./subscriptions";

export const MAX_TITLE_CHARS = 120;
export const EVENTS_PAGE_DEFAULT = 50;
export const EVENTS_PAGE_MAX = 200;

/** A live (not being deleted) dork, or `not_found`. */
export function owned(app: App, dorkId: string): DorkRow {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return fail("not_found", "not found");
  return dork;
}

function checkText(text: unknown) {
  if (typeof text !== "string") fail("invalid", "message is empty");
  const t = text.trim();
  if (!t) fail("invalid", "message is empty");
  if (t.length > MAX_MESSAGE_CHARS) fail("invalid", "message too long");
  return t;
}

/** Durable outbox row + the event clients see. A thrown error rolls both back (e.g. archived dork). */
/** A message without its attached images (`![name](dorks-image:<id>)`), for titles and previews. */
const withoutImages = (text: string) => text.replace(/!\[[^\]]*\]\(\s*dorks-image:[0-9a-f]{32}\s*\)/g, "").trim();
/** A reply's quote (`> Replying to …` lines the web puts first, see apps/web/src/lib/reply.ts) is not what the owner wrote. */
const withoutReply = (text: string) => (/^> Replying to (this part of your message|this image):\n/.test(text) ? text.replace(/^(>.*(\n|$))+/, "") : text);

/** Who sent a message, when it was not the owner: the coordinator dork that started this worker (docs/crew.md). */
export type MessageFrom = { id: string; title: string };

function persistMessage(app: App, dork: DorkRow, text: string, from?: MessageFrom) {
  claimImages(app, dork.id, text);
  enqueue(app, dork.id, "user_message", text);
  append(app, dork.id, { type: "user_message", text, ...(from ? { from } : {}) });
  patchDork(app, dork.id, { preview: (withoutImages(withoutReply(text)) || "Image").slice(0, 140), lastActivityAt: app.now() });
}

export function listDorks(app: App, archived = false): DorkView[] {
  return app.db.all("SELECT * FROM dorks WHERE archived = ? AND deleting = 0 ORDER BY last_activity_at DESC LIMIT 200", archived ? 1 : 0).map((r) => {
    const d = dorkOf(r);
    return dorkView(d, prStateOf(app.db, d));
  });
}

export function getDorkView(app: App, dorkId: string): DorkView | null {
  const d = getDork(app.db, dorkId);
  return d && !d.deleting ? dorkView(d, prStateOf(app.db, d)) : null;
}

/**
 * The transcript. `before` (or neither) pages backwards from the tail, newest first; `after` returns everything newer than a seq,
 * oldest first (tailing). A growing assistant message keeps one row whose text grows in place, so a tailing client re-reads from
 * its last seq inclusive.
 */
export function listEvents(app: App, dorkId: string, q: { before?: number; after?: number; limit?: number }): { events: ClientEvent[]; hasMore: boolean } {
  if (!getDorkView(app, dorkId)) return { events: [], hasMore: false };
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? EVENTS_PAGE_DEFAULT) || EVENTS_PAGE_DEFAULT, 1), EVENTS_PAGE_MAX);
  if (q.after !== undefined) {
    const rows = app.db.all("SELECT * FROM events WHERE dork_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?", dorkId, q.after, limit + 1);
    return { events: rows.slice(0, limit).map(eventOf), hasMore: rows.length > limit };
  }
  const rows =
    q.before !== undefined
      ? app.db.all("SELECT * FROM events WHERE dork_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?", dorkId, q.before, limit + 1)
      : app.db.all("SELECT * FROM events WHERE dork_id = ? ORDER BY seq DESC LIMIT ?", dorkId, limit + 1);
  return { events: rows.slice(0, limit).map(eventOf), hasMore: rows.length > limit };
}

/** The session's starting repo: `owner/name`, or "" for a machine-setup session (docs/builds.md), which needs none. */
function checkRepo(input: unknown, setup: boolean): string {
  const repo = input === undefined || input === null || input === "" ? "" : input;
  if (!(setup && repo === "") && (typeof repo !== "string" || !validRepo(repo))) fail("invalid", "repo must be owner/name");
  return repo as string;
}

/** The build the session starts from, or null for the base machine. */
function checkBuild(app: App, input: unknown, setup: boolean): string | null {
  if (input !== undefined && input !== null && typeof input !== "string") fail("invalid", "buildId must be a string");
  if (setup && typeof input !== "string") fail("invalid", "A setup session needs the build it sets up.");
  // An explicit null is the owner choosing the base machine; only an omitted buildId falls back to the default build.
  const buildId = typeof input === "string" ? input : input === null || setup ? null : defaultBuildId(app);
  if (buildId) {
    const b = getBuild(app, buildId);
    if (!b) fail("not_found", "This build no longer exists.");
    // A setup session may start before the build's first image (it then starts from the base); a working session may not.
    if (!b.image && !setup) fail("not_configured", "This build has not been built yet. Build it first, or start a setup session on it.");
  }
  return buildId;
}

/** A coordinator (docs/crew.md) is a top-level session, never a setup session or a worker; its icon is one emoji. */
function checkKind(input: { kind?: unknown; icon?: unknown }, setup: boolean, parent?: DorkRow): { kind: DorkKind; icon: string | null } {
  if (input.kind !== undefined && input.kind !== "agent" && input.kind !== "coordinator") fail("invalid", "kind must be agent or coordinator");
  const kind: DorkKind = input.kind === "coordinator" ? "coordinator" : "agent";
  if (kind === "coordinator" && (setup || parent)) fail("invalid", "A coordinator cannot be a setup session or a worker.");
  if (input.icon !== undefined && input.icon !== null && (typeof input.icon !== "string" || input.icon.length > 16)) fail("invalid", "icon must be one emoji");
  return { kind, icon: typeof input.icon === "string" && input.icon.trim() ? input.icon.trim() : null };
}

export function createDork(
  app: App,
  input: { repo?: string; message: string; title?: string; provider?: Provider; model?: unknown; effort?: unknown; fast?: unknown; buildId?: unknown; setup?: unknown; kind?: unknown; icon?: unknown },
  // Set only by the crew service (services/crew.ts), never from a request body: the coordinator starting this worker.
  parent?: DorkRow,
): string {
  const { message, title, provider = "claude" } = input;
  const setup = input.setup === true;
  if (provider !== "claude" && provider !== "codex" && provider !== "opencode") fail("invalid", "provider must be claude, codex or opencode");
  const { kind, icon } = checkKind(input, setup, parent);
  // A coordinator plans and delegates (docs/crew.md): it needs no repository of its own.
  const repo = checkRepo(input.repo, setup || kind === "coordinator");
  const buildId = checkBuild(app, input.buildId, setup);
  if (title !== undefined && (typeof title !== "string" || title.trim().length > MAX_TITLE_CHARS)) fail("invalid", "title too long");
  const text = checkText(message);
  const missing = missingForSession(app, provider);
  if (missing) fail("onboarding_incomplete", missing);
  // A Claude session with no model chosen starts on Opus (the current one, by its alias) when the agent offers it, not the CLI's default.
  const choices = provider === "claude" ? knownModelChoices(app) : [];
  const model = input.model || (choices.some((c) => c.model === "opus") ? "opus" : input.model);
  const choice = provider === "claude" ? validModelChoice(choices, model, input.effort, input.fast) : provider === "opencode" ? validOpenCodeModel(undefined, input.model) : { fast: false };

  const id = app.uuid();
  const now = app.now();
  return app.db.tx(() => {
    insert(app.db, "dorks", {
      id,
      title: (title?.trim() || withoutImages(text) || "Image").slice(0, MAX_TITLE_CHARS),
      titleSource: title?.trim() ? "user" : "message",
      repo,
      branch: `agent/${app.uuid().slice(0, 8)}`,
      provider,
      state: "creating",
      archived: false,
      lastActivityAt: now,
      createdAt: now,
      deleting: false,
      buildId,
      kind,
      parentId: parent?.id ?? null,
      icon,
      ...choice,
      codeMode: provider === "claude" && readSettings(app).claudeCodeMode,
    });
    insert(app.db, "dork_runtime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: readSettings(app).sleepMinutes, bridgeSeenAt: 0, bridgeLost: false, opGen: 0, pauseRetries: 0 });
    persistMessage(app, getDork(app.db, id)!, text, parent ? { id: parent.id, title: parent.title } : undefined);
    dispatch(app, id, { t: "start" }); // box failures land in `error` via the box job; the row exists either way
    touch(app, { t: "dorks" });
    return id;
  });
}

export function sendMessage(app: App, dorkId: string, text: string, from?: MessageFrom) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    persistMessage(app, dork, checkText(text), from);
    const r = dispatch(app, dorkId, { t: "user_message" });
    if (r?.rejected) fail("archived", "dork is archived"); // rolls back the persisted message
    for (const sub of subscriptionsOfDork(app, dorkId)) if (sub.status !== "ended") resetCiAttempts(app, sub, "resumed by your message"); // a human is back: CI gets a fresh budget
  });
}

export function chooseCodexModel(app: App, dorkId: string, model: string, effort: string) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (dork.archived) fail("archived", "dork is archived");
    if (dork.provider !== "codex" || dork.state !== "error" || !dork.codexModelChoices?.some((c) => c.model === model && c.efforts.includes(effort)))
      fail("invalid", "choose an available Codex model after the sandbox stops");
    patchDork(app, dorkId, { codexModel: { model, effort }, codexModelChoices: undefined });
    dispatch(app, dorkId, { t: "user_message" });
  });
}

/**
 * A fresh live-view URL of the dork's computer (docs/computer-use.md). Never stored or logged: it is a bearer credential to an
 * interactive desktop. Only an awake dork has a screen; this never wakes one (`sleeping` instead), the next message does.
 */
export async function desktopUrl(app: App, dorkId: string, opts: DesktopOptions): Promise<string> {
  const dork = owned(app, dorkId);
  if (dork.archived) return fail("archived", "dork is archived");
  if (!dork.boxId || (dork.state !== "working" && dork.state !== "idle")) return fail("sleeping", "The computer is asleep. It wakes with your next message.");
  const box = await app.getBox();
  if (!box.desktopUrl) return fail("not_configured", "This sandbox provider has no desktop");
  try {
    return await box.desktopUrl(dork.boxId, opts);
  } catch (e) {
    if (isBoxNotFound(e)) return fail("sleeping", "The computer is asleep. It wakes with your next message.");
    if ((e as { code?: string }).code === "provisioning") return fail("timeout", "The screen is still starting. Try again in a moment.");
    console.error("desktop url failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return fail("failed", "Couldn't open the computer");
  }
}

export function interrupt(app: App, dorkId: string) {
  app.db.tx(() => {
    owned(app, dorkId);
    // Remembered for the turn's end: the error result a stopped turn ends with is then shown as Stopped, not as a failure.
    if (dispatch(app, dorkId, { t: "interrupt" })?.effects.includes("interrupt_agent")) patchRuntime(app, dorkId, { interruptRequested: true });
  });
}

export function setArchived(app: App, dorkId: string, archived: boolean) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (!archived && dork.archived && dork.parentId) checkWorkerRoom(app, dork.parentId); // the same cap as dork_create, from the UI or MCP
    dispatch(app, dorkId, { t: archived ? "archive" : "unarchive" });
    if (archived) archiveWorkers(app, dork);
  });
}

/** A coordinator has room for one more live worker (docs/crew.md), or `limit`. */
export function checkWorkerRoom(app: App, coordinatorId: string) {
  const live = app.db.get<{ n: number }>("SELECT count(*) AS n FROM dorks WHERE parent_id = ? AND archived = 0 AND deleting = 0", coordinatorId)?.n ?? 0;
  if (live >= MAX_LIVE_WORKERS) fail("limit", `This coordinator has ${live} live workers, the most allowed. Archive finished ones (dork_archive) first.`);
}

/** Stopping a coordinator stops its crew (docs/crew.md): its live workers are archived with it. Unarchiving brings back only the coordinator. */
function archiveWorkers(app: App, dork: DorkRow) {
  if (dork.kind !== "coordinator") return;
  for (const w of app.db.all<{ id: string }>("SELECT id FROM dorks WHERE parent_id = ? AND archived = 0 AND deleting = 0", dork.id)) dispatch(app, w.id, { t: "archive" });
}

export function renameDork(app: App, dorkId: string, title: string) {
  app.db.tx(() => {
    owned(app, dorkId);
    const t = typeof title === "string" ? title.trim() : "";
    if (!t || t.length > MAX_TITLE_CHARS) fail("invalid", "bad title");
    patchDork(app, dorkId, { title: t, titleSource: "user" });
  });
}

/** Marks the dork deleting (it disappears from every list at once); the box is destroyed in the background, then the rows are purged. */
export function removeDork(app: App, dorkId: string) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    archiveWorkers(app, dork);
    patchDork(app, dorkId, { deleting: true });
    endDorkSubscriptions(app, dorkId);
    setTimer(app, dorkId, "box:destroy", 0);
  });
}
