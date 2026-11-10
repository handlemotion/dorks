import type { ClientEvent } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { dorkOf, dorkView, eventOf, getDork, type DorkRow, type DorkView, type Provider } from "../data";
import { insert } from "../db";
import { append, dispatch, enqueue, MAX_MESSAGE_CHARS, patchDork, setTimer } from "../lifecycle/dispatch";
import { validRepo } from "../lib/repo";
import { missingForSession } from "./setup";
import { readSettings } from "./settings";
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
function persistMessage(app: App, dork: DorkRow, text: string) {
  enqueue(app, dork.id, "user_message", text);
  append(app, dork.id, { type: "user_message", text });
  patchDork(app, dork.id, { preview: text.slice(0, 140), lastActivityAt: app.now() });
}

export function listDorks(app: App, archived = false): DorkView[] {
  return app.db.all("SELECT * FROM dorks WHERE archived = ? AND deleting = 0 ORDER BY last_activity_at DESC LIMIT 200", archived ? 1 : 0).map((r) => dorkView(dorkOf(r)));
}

export function getDorkView(app: App, dorkId: string): DorkView | null {
  const d = getDork(app.db, dorkId);
  return d && !d.deleting ? dorkView(d) : null;
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
  const rows = q.before !== undefined
    ? app.db.all("SELECT * FROM events WHERE dork_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?", dorkId, q.before, limit + 1)
    : app.db.all("SELECT * FROM events WHERE dork_id = ? ORDER BY seq DESC LIMIT ?", dorkId, limit + 1);
  return { events: rows.slice(0, limit).map(eventOf), hasMore: rows.length > limit };
}

export function createDork(app: App, input: { repo: string; message: string; title?: string; provider?: Provider }): string {
  const { repo, message, title, provider = "claude" } = input;
  if (provider !== "claude" && provider !== "codex") fail("invalid", "provider must be claude or codex");
  if (typeof repo !== "string" || !validRepo(repo)) fail("invalid", "repo must be owner/name");
  if (title !== undefined && (typeof title !== "string" || title.trim().length > MAX_TITLE_CHARS)) fail("invalid", "title too long");
  const text = checkText(message);
  const missing = missingForSession(app, provider);
  if (missing) fail("onboarding_incomplete", missing);

  const id = app.uuid();
  const now = app.now();
  return app.db.tx(() => {
    insert(app.db, "dorks", {
      id, title: (title?.trim() || text).slice(0, MAX_TITLE_CHARS), titleSource: title?.trim() ? "user" : "message", repo, branch: `agent/${app.uuid().slice(0, 8)}`, provider, state: "creating", archived: false,
      lastActivityAt: now, createdAt: now, deleting: false,
    });
    insert(app.db, "dork_runtime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: readSettings(app).sleepMinutes, bridgeSeenAt: 0, bridgeLost: false, opGen: 0, pauseRetries: 0 });
    persistMessage(app, getDork(app.db, id)!, text);
    dispatch(app, id, { t: "start" }); // box failures land in `error` via the box job; the row exists either way
    touch(app, { t: "dorks" });
    return id;
  });
}

export function sendMessage(app: App, dorkId: string, text: string) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    persistMessage(app, dork, checkText(text));
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

export function interrupt(app: App, dorkId: string) {
  app.db.tx(() => {
    owned(app, dorkId);
    dispatch(app, dorkId, { t: "interrupt" });
  });
}

export function setArchived(app: App, dorkId: string, archived: boolean) {
  app.db.tx(() => {
    owned(app, dorkId);
    dispatch(app, dorkId, { t: archived ? "archive" : "unarchive" });
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
    owned(app, dorkId);
    patchDork(app, dorkId, { deleting: true });
    endDorkSubscriptions(app, dorkId);
    setTimer(app, dorkId, "box:destroy", 0);
  });
}
