import { isDorkMode, MAX_LIVE_WORKERS, MODES, type ClientEvent, type DorkMode, type SessionPr } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { dorkOf, dorkView, eventOf, getDork, isUnread, needsAttentionOf, prStateOf, queuedMessagesOf, type DorkRow, type DorkView, type Provider } from "../data";
import { insert } from "../db";
import { dispatch, enqueueConfigure, isAwake, MAX_MESSAGE_CHARS, patchDork, patchRuntime, persistUserMessage, setTimer } from "../lifecycle/dispatch";
import { withoutImages } from "../lib/messageText";
import { knownModelChoices, validAntigravityModel, validModelChoice, validOpenCodeModel } from "./models";
import { validRepo } from "../lib/repo";
import { isBoxNotFound, type DesktopOptions } from "../core/box";
import { missingForSession } from "./setup";
import { readSettings } from "./settings";
import { defaultBuildId, getBuild } from "./builds";
import { claimImages } from "./bridge";
import { endDorkSubscriptions, resetCiAttempts, sessionSubscriptionViews, subscriptionsOfDork } from "./subscriptions";
import { watchedShipsOf } from "./ships";
import type { By } from "./team";

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

/** Who sent a message, when it was not the owner: the coordinator dork that started this worker (docs/crew.md). */
export type MessageFrom = { id: string; title: string };

/** Durable outbox row + the event clients see. A thrown error rolls both back (e.g. archived dork). */
function persistMessage(app: App, dork: DorkRow, text: string, from?: MessageFrom, by?: By) {
  claimImages(app, dork.id, text);
  persistUserMessage(app, dork.id, text, from, by);
}

export function listDorks(app: App, archived = false): DorkView[] {
  return app.db.all("SELECT * FROM dorks WHERE archived = ? AND deleting = 0 ORDER BY last_activity_at DESC LIMIT 200", archived ? 1 : 0).map((r) => {
    const d = dorkOf(r);
    return dorkView(d, prStateOf(app.db, d), needsAttentionOf(app.db, d.id), undefined, sessionPrsOf(app, d.id));
  });
}

/** The session's pull requests as the sidebar shows them: the ones the UI lists, each with what its merge set off while that is followed. */
function sessionPrsOf(app: App, dorkId: string): SessionPr[] {
  const ships = watchedShipsOf(app, dorkId);
  return sessionSubscriptionViews(app, dorkId).map((s) => {
    const ship = ships.findLast((x) => x.repo === s.repo && x.number === s.number);
    return {
      repo: s.repo,
      number: s.number,
      url: s.url,
      ...(s.title ? { title: s.title } : {}),
      state: s.state,
      ...(ship ? { ship: { status: ship.status, stages: ship.stages.map(({ name, state, url }) => ({ name, state, ...(url ? { url } : {}) })) } } : {}),
    };
  });
}

export function getDorkView(app: App, dorkId: string): DorkView | null {
  const d = getDork(app.db, dorkId);
  return d && !d.deleting ? dorkView(d, prStateOf(app.db, d), needsAttentionOf(app.db, d.id), queuedMessagesOf(app.db, d.id), sessionPrsOf(app, d.id)) : null;
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

/**
 * The session's mode (docs/modes.md), code when omitted. A nerd (a coordinator, docs/crew.md) is a top-level session, never a setup
 * session or a worker, and a setup session is always code; its icon is one emoji.
 */
function checkMode(input: { mode?: unknown; icon?: unknown }, setup: boolean, parent?: DorkRow): { mode: DorkMode; icon: string | null } {
  if (input.mode !== undefined && input.mode !== null && !isDorkMode(input.mode)) fail("invalid", "mode must be chat, code or nerd");
  const mode: DorkMode = isDorkMode(input.mode) ? input.mode : "code";
  if (mode === "nerd" && (setup || parent)) fail("invalid", "A nerd cannot be a setup session or a worker.");
  if (mode !== "code" && setup) fail("invalid", "A setup session is a code session.");
  if (input.icon !== undefined && input.icon !== null && (typeof input.icon !== "string" || input.icon.length > 16)) fail("invalid", "icon must be one emoji");
  return { mode, icon: typeof input.icon === "string" && input.icon.trim() ? input.icon.trim() : null };
}

export function createDork(
  app: App,
  input: {
    repo?: string;
    message: string;
    title?: string;
    provider?: Provider;
    model?: unknown;
    effort?: unknown;
    fast?: unknown;
    buildId?: unknown;
    setup?: unknown;
    mode?: unknown;
    icon?: unknown;
    /** Set by the route from the request's actor, never from a body. */ by?: By;
  },
  // Set only by the crew service (services/crew.ts), never from a request body: the coordinator starting this worker.
  parent?: DorkRow,
): string {
  const { message, title, provider = "claude" } = input;
  const setup = input.setup === true;
  if (provider !== "claude" && provider !== "codex" && provider !== "opencode" && provider !== "antigravity") fail("invalid", "provider must be claude, codex, opencode or antigravity");
  const { mode, icon } = checkMode(input, setup, parent);
  // Only a code session works in a repository; a chat or a nerd starts in an empty work directory (one may still be named).
  const repo = checkRepo(input.repo, setup || !MODES[mode].needsRepo);
  const buildId = checkBuild(app, input.buildId, setup);
  if (title !== undefined && (typeof title !== "string" || title.trim().length > MAX_TITLE_CHARS)) fail("invalid", "title too long");
  const text = checkText(message);
  const missing = missingForSession(app, provider);
  if (missing) fail("onboarding_incomplete", missing);
  // A Claude session with no model chosen starts on Opus (the current one, by its alias) when the agent offers it, not the CLI's default.
  const choices = provider === "claude" ? knownModelChoices(app) : [];
  const model = input.model || (choices.some((c) => c.model === "opus") ? "opus" : input.model);
  const choice =
    provider === "claude"
      ? validModelChoice(choices, model, input.effort, input.fast)
      : provider === "opencode"
        ? validOpenCodeModel(undefined, input.model)
        : provider === "antigravity"
          ? validAntigravityModel(undefined, input.model)
          : { fast: false };

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
      mode,
      parentId: parent?.id ?? null,
      icon,
      createdBy: input.by ?? null,
      ...choice,
      codeMode: provider === "claude" && readSettings(app).claudeCodeMode,
    });
    insert(app.db, "dork_runtime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: readSettings(app).sleepMinutes, bridgeSeenAt: 0, bridgeLost: false, opGen: 0, pauseRetries: 0 });
    persistMessage(app, getDork(app.db, id)!, text, parent ? { id: parent.id, title: parent.title } : undefined, input.by);
    dispatch(app, id, { t: "start" }); // box failures land in `error` via the box job; the row exists either way
    touch(app, { t: "dorks" });
    return id;
  });
}

/**
 * A message for the agent now. While it works the message steers the running turn (Claude reads it at its next tool call);
 * otherwise it starts a turn, waking the dork if it sleeps.
 */
export function sendMessage(app: App, dorkId: string, text: string, from?: MessageFrom, by?: By) {
  app.db.tx(() => deliverNow(app, owned(app, dorkId), checkText(text), from, by));
}

function deliverNow(app: App, dork: DorkRow, text: string, from?: MessageFrom, by?: By) {
  persistMessage(app, dork, text, from, by);
  const r = dispatch(app, dork.id, { t: "user_message" });
  if (r?.rejected) fail("archived", "dork is archived"); // rolls back the persisted message
  for (const sub of subscriptionsOfDork(app, dork.id)) if (sub.status !== "ended") resetCiAttempts(app, sub, "resumed by your message"); // a human is back: CI gets a fresh budget
}

export const MAX_QUEUED_MESSAGES = 20;
/** States with a turn running or about to run: a queued message waits for its end. */
const BUSY = new Set(["creating", "waking", "working"]);

/**
 * A message for when the agent's current turn ends (the composer's ⌘ Enter). Each queued message goes out as its own turn, oldest
 * first; the machine releases one at every turn boundary (`release_queue`). With no turn running it is sent now. Resolves whether it
 * was queued.
 */
export function queueMessage(app: App, dorkId: string, text: string, by?: By): { queued: boolean } {
  return app.db.tx(() => {
    const dork = owned(app, dorkId);
    const t = checkText(text);
    if (dork.archived) fail("archived", "dork is archived");
    if (!BUSY.has(dork.state)) {
      deliverNow(app, dork, t, undefined, by);
      return { queued: false };
    }
    const n = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM queued_messages WHERE dork_id = ?", dorkId)?.n ?? 0;
    if (n >= MAX_QUEUED_MESSAGES) fail("limit", `at most ${MAX_QUEUED_MESSAGES} messages can wait in the queue`);
    claimImages(app, dorkId, t);
    app.db.run("INSERT INTO queued_messages (id, dork_id, text, created_at, sent_by) VALUES (?, ?, ?, ?, ?)", app.uuid(), dorkId, t, app.now(), by ? JSON.stringify(by) : null);
    touch(app, { t: "dork", dorkId });
    return { queued: true };
  });
}

/** Takes a message out of the queue; `send` delivers it now instead (steering a running turn). */
export function takeQueued(app: App, dorkId: string, queuedId: string, send: boolean) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    const row = app.db.get<{ text: string; sent_by: string | null }>("SELECT text, sent_by FROM queued_messages WHERE id = ? AND dork_id = ?", queuedId, dorkId);
    if (!row) fail("not_found", "that message is no longer queued");
    app.db.run("DELETE FROM queued_messages WHERE id = ?", queuedId);
    touch(app, { t: "dork", dorkId });
    if (send) deliverNow(app, dork, row.text, undefined, row.sent_by ? (JSON.parse(row.sent_by) as By) : undefined);
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
    // The queue waits too: a stopped agent does not go on with the next queued message by itself.
    if (dispatch(app, dorkId, { t: "interrupt" })?.effects.includes("interrupt_agent"))
      patchRuntime(app, dorkId, { interruptRequested: true, queueHold: !!app.db.get("SELECT 1 AS x FROM queued_messages WHERE dork_id = ? LIMIT 1", dorkId) });
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
  for (const w of app.db.all<{ id: string }>("SELECT id FROM dorks WHERE parent_id = ? AND archived = 0 AND deleting = 0", dork.id)) dispatch(app, w.id, { t: "archive" });
}

/**
 * Switches a session's mode (docs/modes.md). Stored at once; an awake agent restarts on the same session with the new mode's
 * instructions and tools once its current turn is over (as for a model change), a sleeping one wakes with them. A worker keeps its
 * crew's mode, and a nerd with live workers stays one until they are archived.
 */
export function setMode(app: App, dorkId: string, mode: unknown) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (!isDorkMode(mode)) fail("invalid", "mode must be chat, code or nerd");
    if (dork.archived) fail("archived", "dork is archived");
    if (dork.mode === mode) return;
    if (dork.parentId) fail("invalid", "A worker keeps the mode its coordinator gave it.");
    const live = app.db.get<{ n: number }>("SELECT count(*) AS n FROM dorks WHERE parent_id = ? AND archived = 0 AND deleting = 0", dorkId)?.n ?? 0;
    if (dork.mode === "nerd" && live > 0) fail("conflict", `This nerd still runs ${live} session${live === 1 ? "" : "s"}. Archive them before switching.`);
    patchDork(app, dorkId, { mode });
    if (isAwake(dork.state)) {
      // As in chooseModel: replace a configure the bridge may already have fetched, so it fetches the new one.
      app.db.run("DELETE FROM commands WHERE dork_id = ? AND kind = 'configure' AND acked = 0", dorkId);
      enqueueConfigure(app, dorkId);
    }
  });
}

/** The owner read the chat (on any device): it stops showing as unread. */
export function markRead(app: App, dorkId: string) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (isUnread(dork)) patchDork(app, dorkId, { readAt: app.now() });
  });
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
