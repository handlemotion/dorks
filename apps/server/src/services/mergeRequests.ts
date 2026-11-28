import type { MergeMethod } from "@dorks/shared";
import { AppFail, fail, touch, type App } from "../app";
import { getDork } from "../data";
import { insert, update } from "../db";
import { append, dispatch, enqueue } from "../lifecycle/dispatch";
import { defaultMergeMethod, mergePullRequest, pullHead } from "./pullRequest";

// Asking to merge (docs/autonomy.md, "Asking to merge"): when one of its PRs is ready, the agent asks the owner with the
// `pr_merge_request` tool instead of stopping. The owner sees a card in the chat (Merge / Not now); Merge merges the head the agent
// asked about, pinned to that commit, so nothing pushed after the card appeared is merged unseen. The answer reaches the agent as its
// next turn, so it carries on (follows the ship, fixes what GitHub refused, or leaves the PR alone). The agent never merges itself.

export const MAX_NOTE_CHARS = 500;

type Status = "pending" | "merging" | "merged" | "queued" | "declined" | "failed" | "replaced";

interface RequestRow {
  id: string;
  dork_id: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  sha: string;
  note: string | null;
  status: Status;
  reason: string | null;
  created_at: number;
}

const row = (app: App, id: string) => app.db.get<RequestRow>("SELECT * FROM merge_requests WHERE id = ?", id);
const ref = (r: Pick<RequestRow, "repo" | "number">) => `${r.repo}#${r.number}`;
const errorText = (e: unknown) => (e instanceof AppFail ? e.error.message : "Something went wrong while merging.");

function changed(app: App, dorkId: string) {
  touch(app, { t: "dorks" });
  touch(app, { t: "dork", dorkId });
}

/** In a transaction: the request ends as `status`, and the card says so. */
function settle(app: App, r: RequestRow, status: Exclude<Status, "pending" | "merging">, extra: { method?: MergeMethod; reason?: string } = {}) {
  update(app.db, "merge_requests", { id: r.id }, { status, reason: extra.reason ?? null, decidedAt: app.now() });
  if (!getDork(app.db, r.dork_id)) return;
  append(app, r.dork_id, { type: "merge_decision", requestId: r.id, status, ...(extra.method ? { method: extra.method } : {}), ...(extra.reason ? { reason: extra.reason } : {}) });
  changed(app, r.dork_id);
}

/** The owner's answer, as the agent's next turn. */
function tell(app: App, dorkId: string, text: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  enqueue(app, dorkId, "user_message", `<dorks-event>${text}</dorks-event>`);
  dispatch(app, dorkId, { t: "user_message" });
}

/** The bridge op `merge`: the agent asks the owner to merge one of the PRs this session opened or follows. */
export async function mergeOp(app: App, dorkId: string, args: Record<string, unknown>): Promise<unknown> {
  if (args.action !== "request") return fail("invalid", "unknown merge action");
  const url = args.url;
  if (typeof url !== "string" || !url) return fail("invalid", "url must be a pull request URL");
  const note = args.note;
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE_CHARS)) fail("invalid", `note must be at most ${MAX_NOTE_CHARS} characters`);
  const text = typeof note === "string" ? note.trim() : "";
  const pr = await pullHead(app, dorkId, url);
  if (pr.merged) return fail("conflict", `${ref(pr)} is already merged.`);
  if (pr.closed) return fail("conflict", `${ref(pr)} is closed.`);
  if (pr.draft) return fail("conflict", `${ref(pr)} is a draft. Mark it ready with \`gh pr ready\` first, then ask again.`);
  if (!pr.sha) return fail("failed", "GitHub did not say which commit the pull request is at.");
  const canonical = `https://github.com/${pr.repo}/pull/${pr.number}`;
  return app.db.tx(() => {
    const dork = getDork(app.db, dorkId);
    if (!dork || dork.deleting) return fail("not_found", "This session no longer exists.");
    // One card per PR: asking again (after a push, say) replaces the card still waiting.
    for (const old of app.db.all<RequestRow>("SELECT * FROM merge_requests WHERE dork_id = ? AND repo = ? AND number = ? AND status = 'pending'", dorkId, pr.repo, pr.number))
      settle(app, old, "replaced");
    const id = app.uuid();
    insert(app.db, "merge_requests", { id, dorkId, repo: pr.repo, number: pr.number, url: canonical, title: pr.title, sha: pr.sha, note: text || null, status: "pending", createdAt: app.now() });
    append(app, dorkId, { type: "merge_request", requestId: id, repo: pr.repo, number: pr.number, url: canonical, title: pr.title, sha: pr.sha, ...(text ? { note: text } : {}) });
    changed(app, dorkId);
    return { requestId: id, status: "pending" };
  });
}

/**
 * The owner answers a card: `merge: true` merges the commit the agent asked about with the repository's first allowed method;
 * `false` declines. Either way the agent hears it as its next turn. Returns how it ended.
 */
export async function decideMerge(app: App, dorkId: string, requestId: string, merge: unknown): Promise<{ status: Status; reason?: string }> {
  if (typeof merge !== "boolean") return fail("invalid", "merge must be true or false");
  // Claim the request first, so a second click (or a second device) cannot merge twice.
  const r = app.db.tx(() => {
    const r = row(app, requestId);
    if (!r || r.dork_id !== dorkId) return fail("not_found", "This request no longer exists.");
    if (r.status !== "pending") return fail("conflict", "This request was already answered.");
    if (!merge) {
      settle(app, r, "declined");
      return null;
    }
    update(app.db, "merge_requests", { id: r.id }, { status: "merging" });
    return r;
  });
  if (!r) {
    const d = row(app, requestId)!;
    tell(app, dorkId, `The owner chose not to merge ${ref(d)} for now. Leave it open, and do not ask again unless something changes or they ask you to.`);
    return { status: "declined" };
  }
  let method: MergeMethod | undefined;
  try {
    method = await defaultMergeMethod(app, r.repo);
    const out = await mergePullRequest(app, dorkId, method, r.sha, r.url);
    const status = out.merged ? "merged" : "queued";
    app.db.tx(() => settle(app, r, status, { method }));
    tell(
      app,
      dorkId,
      out.merged
        ? `The owner approved: ${ref(r)} is merged (${method}). The server follows it to production and wakes you with a \`deployed\` or \`ship_failed\` event. Carry on with any other work you were asked to do; otherwise stop.`
        : `The owner approved: ${ref(r)} was handed to GitHub to merge (a merge queue or a stack). You will hear when it lands. Carry on with any other work you were asked to do; otherwise stop.`,
    );
    return { status };
  } catch (e) {
    const reason = errorText(e);
    app.db.tx(() => settle(app, r, "failed", { ...(method ? { method } : {}), reason }));
    tell(
      app,
      dorkId,
      `The owner approved merging ${ref(r)}, but it did not merge: ${reason} Fix what that names (pull in the base, resolve conflicts, get CI green, address the review), push, and ask again with pr_merge_request. Never merge it yourself.`,
    );
    return { status: "failed", reason };
  }
}

/** The PR was merged or closed some other way (on GitHub, from the PR tab): a card still waiting for it says so. */
export function settleMergeRequests(app: App, dorkId: string, repo: string, number: number, merged: boolean) {
  for (const r of app.db.all<RequestRow>("SELECT * FROM merge_requests WHERE dork_id = ? AND repo = ? AND number = ? AND status = 'pending'", dorkId, repo, number))
    settle(app, r, merged ? "merged" : "failed", merged ? {} : { reason: "The pull request was closed." });
}
