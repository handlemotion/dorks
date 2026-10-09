import type { NotifyKind } from "@dorks/shared";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { append, dispatch, runtimeOf, setTimer, userMessagePending } from "./dispatch";
import { renderNotification, type PrSection } from "./notifyRender";

export const NOTIFY_DEBOUNCE_MS = 45_000; // events within one window of the first become a single notification

/**
 * Buffers one event for a dork and arms the `notify` timer if it is not running. The webhook ingress calls this once per event it
 * wants the agent to hear about; the timer (lifecycle.timer) then folds everything buffered into ONE `notify` command. The window
 * starts at the first event and does not slide, so a chatty PR cannot hold a notification back forever.
 * Archived and deleting dorks hear nothing.
 */
export async function enqueueNotification(
  ctx: MutationCtx, dorkId: Id<"dorks">, subscriptionId: Id<"prSubscriptions">, kind: NotifyKind, summary: string, deliveryId?: string,
) {
  const dork = await ctx.db.get(dorkId);
  if (!dork || dork.deleting || dork.archived) return;
  await ctx.db.insert("inbox", { dorkId, subscriptionId, kind, summary, deliveryId, createdAt: Date.now(), delivered: false });
  if (!(await runtimeOf(ctx, dorkId)).timers.notify) await setTimer(ctx, dorkId, "notify", NOTIFY_DEBOUNCE_MS);
}

/**
 * The `notify` timer fired: render everything buffered into one envelope, persist it as a `notify` command (+ its transcript card)
 * and hand it to the lifecycle machine, which wakes the box, delivers, or holds it until the current turn ends.
 */
export async function foldInbox(ctx: MutationCtx, dorkId: Id<"dorks">) {
  const dork = await ctx.db.get(dorkId);
  if (!dork || dork.deleting) return;
  const rows = await ctx.db.query("inbox").withIndex("by_dork_delivered", (q) => q.eq("dorkId", dorkId).eq("delivered", false)).collect();
  if (!rows.length) return;
  for (const row of rows) await ctx.db.patch(row._id, { delivered: true });
  if (dork.archived) return; // archived while the window was open: nothing wakes an archived dork

  const sections = new Map<Id<"prSubscriptions">, PrSection>();
  for (const row of rows) {
    let section = sections.get(row.subscriptionId);
    if (!section) {
      const sub = await ctx.db.get(row.subscriptionId);
      if (!sub) continue; // purged
      section = { repo: sub.repo, number: sub.number, url: sub.url, title: sub.title, headRef: sub.headRef, baseRef: sub.baseRef, ciFixAttempts: sub.ciFixAttempts, items: [] };
      sections.set(row.subscriptionId, section);
    }
    section.items.push({ kind: row.kind, summary: row.summary });
  }
  if (!sections.size) return;

  const { text, digest, kinds, prs } = renderNotification([...sections.values()]);
  // Mid-turn, or behind a user message, the notify is held: the machine's release_notify frees it at the next turn boundary.
  const released = dork.state !== "working" && !(await userMessagePending(ctx, dorkId));
  await ctx.db.insert("commands", { dorkId, kind: "notify", cid: crypto.randomUUID(), text, meta: { kinds, prs }, released, acked: false });
  await append(ctx, dorkId, { type: "notify", kinds, prs, text: digest });
  await dispatch(ctx, dorkId, { t: "notify" });
}
