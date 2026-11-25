import { z } from "zod";

// Preview comments (docs/architecture.md, "Preview comments"): the owner comments on a running preview, on an element or on a
// passage of text. Dorks stores the threads; the owner's comments reach the agent as one `notify` turn (source "preview"), and the
// agent answers in the thread with the comment_* MCP tools. Anchors come from the preview overlay (infra/bridge/overlay/overlay.ts).

const where = {
  /** The page: location.pathname + search + hash, as the overlay saw it. */
  path: z.string().max(2000),
  /** A CSS selector for the element (React Grab's `getElementSelector`). */
  selector: z.string().max(2000),
  /** What the element is, for people and the agent: its tag, or its component. */
  label: z.string().max(200),
  /** React's source location when the page exposes it (a dev build). */
  component: z.string().max(200).optional(),
  file: z.string().max(500).optional(),
  line: z.number().int().optional(),
};

export const commentAnchor = z.discriminatedUnion("kind", [
  /** A whole element: its markup, cut short. */
  z.object({ kind: z.literal("element"), ...where, html: z.string().max(4000).optional() }),
  /** A passage of text inside the element: the words, and a little of what comes before and after them, to find them again. */
  z.object({ kind: z.literal("text"), ...where, quote: z.string().min(1).max(2000), prefix: z.string().max(200), suffix: z.string().max(200) }),
]);
export type CommentAnchor = z.infer<typeof commentAnchor>;

export const commentAuthor = z.enum(["owner", "agent"]);
export type CommentAuthor = z.infer<typeof commentAuthor>;

export const MAX_COMMENT_CHARS = 8_000;
export const MAX_COMMENTS = 500;

export interface CommentView {
  id: string;
  /** The thread's first comment; null for that first comment itself. */
  parentId: string | null;
  author: CommentAuthor;
  body: string;
  /** Where a thread points (its first comment only). */
  anchor: CommentAnchor | null;
  /** The preview's dev server port (its first comment only). */
  port: number | null;
  resolvedAt: number | null;
  resolvedBy: CommentAuthor | null;
  createdAt: number;
  editedAt: number | null;
}

export interface CommentThread {
  root: CommentView;
  replies: CommentView[];
}

/** Comments as threads, oldest first; `resolved` picks resolved or open ones. */
export function commentThreads(comments: CommentView[], resolved?: boolean): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const c of comments) if (!c.parentId) threads.set(c.id, { root: c, replies: [] });
  for (const c of comments) if (c.parentId) threads.get(c.parentId)?.replies.push(c);
  const all = [...threads.values()];
  return resolved === undefined ? all : all.filter((t) => !!t.root.resolvedAt === resolved);
}

/** One line on where a thread points, for the agent and for mentions: `on /settings, <button> in SubmitButton (src/Button.tsx:12)`. */
export function anchorLine(a: CommentAnchor): string {
  const what =
    a.kind === "text"
      ? `the text "${a.quote.length > 120 ? `${a.quote.slice(0, 120)}…` : a.quote}" in ${a.component ?? `<${a.label}>`}`
      : a.component
        ? `<${a.label}> in ${a.component}`
        : `<${a.label}>`;
  const src = a.file ? ` (${a.file}${a.line ? `:${a.line}` : ""})` : "";
  return `on ${a.path || "/"}, ${what}${src}`;
}
