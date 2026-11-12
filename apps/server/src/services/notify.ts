import type { NotifyKind } from "@dorks/shared";
import type { App } from "../app";
import { getDork } from "../data";
import { insert, update } from "../db";
import { append, dispatch, hasTimer, setTimer, userMessagePending } from "../lifecycle/dispatch";
import { touch } from "../app";
import { renderNotification, type PrSection } from "../lib/notifyRender";

export const NOTIFY_DEBOUNCE_MS = 45_000; // events within one window of the first become a single notification

/**
 * Buffers one event for a dork and arms the `notify` timer if it is not running. The poller calls this once per event it wants
 * the agent to hear about; the timer then folds everything buffered into ONE `notify` command. The window starts at the first
 * event and does not slide, so a chatty PR cannot hold a notification back forever. Archived and deleting dorks hear nothing.
 */
export function enqueueNotification(app: App, dorkId: string, subscriptionId: number, kind: NotifyKind, summary: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting || dork.archived) return;
  insert(app.db, "inbox", { dorkId, subscriptionId, kind, summary, createdAt: app.now(), delivered: false });
  if (!hasTimer(app, dorkId, "notify")) setTimer(app, dorkId, "notify", NOTIFY_DEBOUNCE_MS);
}

/**
 * The `notify` timer fired: render everything buffered into one envelope, persist it as a `notify` command (+ its transcript card)
 * and hand it to the lifecycle machine, which wakes the box, delivers, or holds it until the current turn ends.
 */
export function foldInbox(app: App, dorkId: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  const rows = app.db.all<{ id: number; subscription_id: number; kind: NotifyKind; summary: string }>("SELECT * FROM inbox WHERE dork_id = ? AND delivered = 0 ORDER BY id", dorkId);
  if (!rows.length) return;
  for (const row of rows) update(app.db, "inbox", { id: row.id }, { delivered: true });
  if (dork.archived) return; // archived while the window was open: nothing wakes an archived dork

  const sections = new Map<number, PrSection>();
  for (const row of rows) {
    let section = sections.get(row.subscription_id);
    if (!section) {
      const sub = app.db.get("SELECT * FROM pr_subscriptions WHERE id = ?", row.subscription_id);
      if (!sub) continue; // purged
      section = {
        repo: sub.repo as string,
        number: sub.number as number,
        url: sub.url as string,
        title: (sub.title as string | null) ?? undefined,
        headRef: (sub.head_ref as string | null) ?? undefined,
        baseRef: (sub.base_ref as string | null) ?? undefined,
        ciFixAttempts: sub.ci_fix_attempts as number,
        items: [],
      };
      sections.set(row.subscription_id, section);
    }
    section.items.push({ kind: row.kind, summary: row.summary });
  }
  if (!sections.size) return;

  const { text, digest, kinds, prs } = renderNotification([...sections.values()]);
  // Mid-turn, or behind a user message, the notify is held: the machine's release_notify frees it at the next turn boundary.
  const released = dork.state !== "working" && !userMessagePending(app, dorkId);
  insert(app.db, "commands", { dorkId, kind: "notify", cid: app.uuid(), text, meta: { kinds, prs }, released, acked: false });
  touch(app, { t: "commands", dorkId });
  append(app, dorkId, { type: "notify", kinds, prs, text: digest });
  dispatch(app, dorkId, { t: "notify" });
}
