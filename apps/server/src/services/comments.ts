import { anchorLine, commentAnchor, commentThreads, MAX_COMMENT_CHARS, MAX_COMMENTS, NOTIFY_TAG, type CommentAnchor, type CommentAuthor, type CommentView } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { getDork } from "../data";
import { insert, update } from "../db";
import { append, dispatch, hasTimer, setTimer, userMessagePending } from "../lifecycle/dispatch";
import { claimImages } from "./bridge";
import { owned } from "./dorks";

// Preview comments (docs/architecture.md, "Preview comments"). The owner comments on a running preview; each comment of theirs waits
// (notified = 0) for the `comments_notify` timer, which folds everything waiting into one `notify` turn, as PR notifications and crew
// reports do. The agent reads and answers through the bridge's `comment` op (the comment_* MCP tools).

export const COMMENTS_NOTIFY_MS = 5_000;

type Row = {
  id: string;
  dork_id: string;
  parent_id: string | null;
  author: CommentAuthor;
  body: string;
  anchor: string | null;
  port: number | null;
  resolved_at: number | null;
  resolved_by: CommentAuthor | null;
  created_at: number;
  edited_at: number | null;
};

function view(r: Row): CommentView {
  let anchor: CommentAnchor | null = null;
  if (r.anchor) {
    const parsed = commentAnchor.safeParse(JSON.parse(r.anchor));
    if (parsed.success) anchor = parsed.data;
  }
  return {
    id: r.id,
    parentId: r.parent_id,
    author: r.author,
    body: r.body,
    anchor,
    port: r.port,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  };
}

export function listComments(app: App, dorkId: string): CommentView[] {
  return app.db.all<Row>("SELECT * FROM preview_comments WHERE dork_id = ? ORDER BY created_at, rowid", dorkId).map(view);
}

function row(app: App, dorkId: string, id: unknown): Row {
  if (typeof id !== "string" || !id) return fail("invalid", "id is required");
  const r = app.db.get<Row>("SELECT * FROM preview_comments WHERE dork_id = ? AND id = ?", dorkId, id);
  return r ?? fail("not_found", "no such comment");
}

function text(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) return fail("invalid", "the comment is empty");
  const t = body.trim();
  if (t.length > MAX_COMMENT_CHARS) fail("invalid", `a comment is at most ${MAX_COMMENT_CHARS} characters`);
  return t;
}

function room(app: App, dorkId: string) {
  const n = app.db.get<{ n: number }>("SELECT count(*) AS n FROM preview_comments WHERE dork_id = ?", dorkId)?.n ?? 0;
  if (n >= MAX_COMMENTS) fail("limit", `at most ${MAX_COMMENTS} comments per session`);
}

/** The owner's comment waits for the agent; the timer's window starts at the first one and does not slide. */
function queue(app: App, dorkId: string) {
  if (!hasTimer(app, dorkId, "comments_notify")) setTimer(app, dorkId, "comments_notify", COMMENTS_NOTIFY_MS);
}

// ---------------------------------------------------------------- the owner (UI API)

export function addComment(app: App, dorkId: string, input: { body: unknown; anchor: unknown; port: unknown }): { id: string } {
  return app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (dork.archived) fail("archived", "this session is archived");
    const parsed = commentAnchor.safeParse(input.anchor);
    if (!parsed.success) return fail("invalid", "the comment needs an anchor on the page");
    const anchor = parsed.data;
    // A comment on an image points at one of this session's images and has no preview port.
    const port = anchor.kind === "image" ? null : input.port;
    if (anchor.kind === "image") {
      if (!app.db.get("SELECT 1 FROM images WHERE id = ? AND dork_id = ?", anchor.image, dorkId)) fail("not_found", "no such image in this session");
    } else if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return fail("invalid", "port must be the preview's port");
    room(app, dorkId);
    const id = app.uuid();
    // An area's screenshot was uploaded like an attachment: the comment makes it this dork's, so the agent can load it.
    if (anchor.kind === "area" && anchor.image) claimImages(app, dorkId, `dorks-image:${anchor.image}`);
    insert(app.db, "preview_comments", { id, dorkId, parentId: null, author: "owner", body: text(input.body), anchor: JSON.stringify(anchor), port, notified: false, createdAt: app.now() });
    queue(app, dorkId);
    touch(app, { t: "comments", dorkId });
    return { id };
  });
}

export function replyComment(app: App, dorkId: string, parentId: string, body: unknown, author: CommentAuthor = "owner"): { id: string } {
  return app.db.tx(() => {
    owned(app, dorkId);
    const parent = row(app, dorkId, parentId);
    if (parent.parent_id) fail("invalid", "reply to the thread's first comment");
    room(app, dorkId);
    const id = app.uuid();
    insert(app.db, "preview_comments", { id, dorkId, parentId: parent.id, author, body: text(body), notified: author !== "owner", createdAt: app.now() });
    if (author === "owner") {
      // Writing in a resolved thread opens it again.
      if (parent.resolved_at) update(app.db, "preview_comments", { id: parent.id }, { resolvedAt: null, resolvedBy: null });
      queue(app, dorkId);
    }
    touch(app, { t: "comments", dorkId });
    return { id };
  });
}

export function changeComment(app: App, dorkId: string, id: string, change: { body?: unknown; resolved?: unknown }, by: CommentAuthor = "owner") {
  app.db.tx(() => {
    owned(app, dorkId);
    const r = row(app, dorkId, id);
    if (change.body !== undefined) {
      if (r.author !== by) fail("forbidden", "only its author can edit a comment");
      update(app.db, "preview_comments", { id }, { body: text(change.body), editedAt: app.now() });
    }
    if (change.resolved !== undefined) {
      if (r.parent_id) fail("invalid", "resolve the thread's first comment");
      const resolved = change.resolved === true;
      update(app.db, "preview_comments", { id }, resolved ? { resolvedAt: app.now(), resolvedBy: by } : { resolvedAt: null, resolvedBy: null });
    }
    touch(app, { t: "comments", dorkId });
  });
}

export function deleteComment(app: App, dorkId: string, id: string) {
  app.db.tx(() => {
    owned(app, dorkId);
    const r = row(app, dorkId, id);
    if (r.author !== "owner") fail("forbidden", "only your own comments can be deleted");
    app.db.run("DELETE FROM preview_comments WHERE id = ?", id); // a thread's replies go with it (ON DELETE CASCADE)
    touch(app, { t: "comments", dorkId });
  });
}

// ---------------------------------------------------------------- the agent (bridge op `comment`)

const quote = (s: string) => s.replace(new RegExp(`<(/?)${NOTIFY_TAG}`, "gi"), "&lt;$1" + NOTIFY_TAG).replace(/\n/g, "\n  > ");

/** One thread as the agent reads it (comment_list). */
function threadText(c: CommentView, replies: CommentView[]): string {
  const head = `## ${c.id}${c.resolvedAt ? " (resolved)" : ""}: ${c.anchor ? anchorLine(c.anchor) : "on the preview"}${c.port ? `, port ${c.port}` : ""}`;
  const lines = [c, ...replies].map((m) => `- ${m.author === "owner" ? "user" : "you"}: ${quote(m.body)}`);
  return [head, ...lines].join("\n");
}

export function commentOp(app: App, dorkId: string, args: Record<string, unknown>): unknown {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return fail("forbidden", "forbidden");
  switch (args.action) {
    case "list": {
      const threads = commentThreads(listComments(app, dorkId), args.all === true ? undefined : false);
      return { text: threads.length ? threads.map((t) => threadText(t.root, t.replies)).join("\n\n") : args.all === true ? "No comments on the preview." : "No open comments on the preview." };
    }
    case "reply":
      return replyComment(app, dorkId, String(args.id ?? ""), args.body, "agent");
    case "resolve": {
      const id = String(args.id ?? "");
      if (args.body !== undefined && args.body !== "") replyComment(app, dorkId, id, args.body, "agent");
      changeComment(app, dorkId, id, { resolved: true }, "agent");
      return {};
    }
    default:
      return fail("invalid", "unknown comment action");
  }
}

// ---------------------------------------------------------------- the `comments_notify` timer

/** Everything the owner wrote since the last fold becomes one `notify` turn and one transcript card. */
export function foldComments(app: App, dorkId: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  const rows = app.db.all<Row>("SELECT * FROM preview_comments WHERE dork_id = ? AND notified = 0 ORDER BY created_at, rowid", dorkId);
  if (!rows.length) return;
  for (const r of rows) update(app.db, "preview_comments", { id: r.id }, { notified: true });
  if (dork.archived) return;
  const all = listComments(app, dorkId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const blocks = rows.map((r) => {
    const c = view(r);
    const root = c.parentId ? byId.get(c.parentId) : c;
    const where = root?.anchor ? anchorLine(root.anchor) : "on the preview";
    if (c.parentId) return `## Reply in thread ${c.parentId} (${where})\n  > ${quote(c.body)}`;
    // The bridge turns this line into the image itself in the agent's turn (infra/bridge/src/claude.ts, userContent).
    const shot =
      c.anchor?.kind === "area" && c.anchor.image
        ? `\n  ![Screenshot of the area](dorks-image:${c.anchor.image})`
        : c.anchor?.kind === "image"
          ? `\n  ![The image commented on](dorks-image:${c.anchor.image})`
          : "";
    return `## New comment ${c.id} ${where}${c.port ? `, port ${c.port}` : ""}\n  > ${quote(c.body)}${shot}`;
  });
  const digest = rows.map((r) => r.body).join("\n\n");
  const text = [
    `<${NOTIFY_TAG} source="preview">`,
    rows.some((r) => r.port === null && !r.parent_id) ? "The user commented on the running preview or on images in this session." : "The user commented on the running preview.",
    "",
    blocks.join("\n\n"),
    "",
    "Address each comment: make the change, check it in the preview, then answer in its thread with comment_reply, or comment_resolve with a " +
      "short note of what you changed once it is done. Ask in the thread when something is unclear. comment_list shows every open thread.",
    `</${NOTIFY_TAG}>`,
  ].join("\n");
  const released = dork.state !== "working" && !userMessagePending(app, dorkId);
  insert(app.db, "commands", { dorkId, kind: "notify", cid: app.uuid(), text, meta: { kinds: [], prs: [] }, released, acked: false });
  touch(app, { t: "commands", dorkId });
  append(app, dorkId, { type: "notify", kinds: [], prs: [], text: digest, source: "preview" });
  dispatch(app, dorkId, { t: "notify" });
}
