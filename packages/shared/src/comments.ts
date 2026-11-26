import { z } from "zod";

// Preview comments (docs/architecture.md, "Preview comments"): the owner comments on a running preview, on an element or on a
// passage of text, or on an image of the session in the lightbox (a point or an area of it). Dorks stores the threads; the owner's comments reach the agent as one `notify` turn (source "preview"), and the
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
  /** A drawn area, in document pixels (scrolled with the page), with its screenshot (an image id, `dorks-image:<id>`). */
  z.object({
    kind: z.literal("area"),
    ...where,
    rect: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
    image: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  }),
  /**
   * A point or an area of one of the session's images (a screenshot the agent shared, an attachment), opened in the lightbox. Its
   * place is in fractions of the image's size (0 to 1 from its top-left corner), so it holds at any size; an area adds its size.
   */
  z.object({
    kind: z.literal("image"),
    image: z.string().regex(/^[0-9a-f]{32}$/),
    /** The image's caption or name. */
    label: z.string().max(200),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1).optional(),
    height: z.number().positive().max(1).optional(),
  }),
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
  /** The teammate who wrote it on a team server (docs/cloud.md); absent for the local owner and the agent. */
  by?: { id: string; name: string };
  body: string;
  /** Where a thread points (its first comment only). */
  anchor: CommentAnchor | null;
  /** The preview's dev server port (its first comment only; null on an image). */
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
  if (a.kind === "image") {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const where = a.width && a.height ? `the area at ${pct(a.x)}, ${pct(a.y)} (${pct(a.width)} × ${pct(a.height)} of it)` : `the point at ${pct(a.x)}, ${pct(a.y)}`;
    return `on the image "${a.label}" (dorks-image:${a.image}), ${where} from its top-left corner`;
  }
  if (a.kind === "area") return `on ${a.path || "/"}, the area at ${Math.round(a.rect.x)},${Math.round(a.rect.y)} (${Math.round(a.rect.width)} × ${Math.round(a.rect.height)} px)`;
  const what =
    a.kind === "text"
      ? `the text "${a.quote.length > 120 ? `${a.quote.slice(0, 120)}…` : a.quote}" in ${a.component ?? `<${a.label}>`}`
      : a.component
        ? `<${a.label}> in ${a.component}`
        : `<${a.label}>`;
  const src = a.file ? ` (${a.file}${a.line ? `:${a.line}` : ""})` : "";
  return `on ${a.path || "/"}, ${what}${src}`;
}
