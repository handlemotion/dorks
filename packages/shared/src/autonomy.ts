import { z } from "zod";

// Autonomy: PR subscriptions and the notifications they produce. Shared by the backend (apps/convex) and the in-box bridge
// (infra/bridge). See docs/autonomy.md for the design; this file is the wire contract between the two.

/** A failing CI run is handed to the agent at most this many times in a row per PR; then the dork stops and escalates. */
export const CI_FIX_MAX_ATTEMPTS = 2;

export const prRef = z.object({
  repo: z.string(), // owner/name
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof prRef>;

/** Who subscribed: the gh shim / PostToolUse hook on `gh pr create` (auto), the agent via `dorks pr sub` (agent), or the user (user). */
export const subscriptionSource = z.enum(["auto", "agent", "user"]);
/** `stalled`: CI failed after CI_FIX_MAX_ATTEMPTS fixes; no more CI notifications until a human acts (comment, message, resubscribe). */
export const subscriptionStatus = z.enum(["active", "stalled", "ended"]);
export const ciState = z.enum(["unknown", "pending", "passing", "failing"]);
export const reviewState = z.enum(["none", "commented", "changes_requested", "approved"]);

/** What the backend knows about a subscribed PR. Returned by `bridge.subscriptions` and the user-facing list. */
export const subscriptionView = prRef.extend({
  url: z.string(),
  title: z.string().optional(),
  headRef: z.string().optional(),
  baseRef: z.string().optional(),
  headSha: z.string().optional(),
  source: subscriptionSource,
  status: subscriptionStatus,
  ci: ciState,
  review: reviewState,
  /** null = GitHub has not computed it yet. */
  mergeable: z.boolean().nullable(),
  ciFixAttempts: z.number().int(),
  state: z.enum(["open", "closed", "merged"]),
});
export type SubscriptionView = z.infer<typeof subscriptionView>;

/**
 * Kinds of notification the backend delivers to the agent. One delivered notification is a digest of everything that happened on
 * one or more PRs during the debounce window; `kinds` lists what it contains.
 */
export const notifyKind = z.enum([
  "ci_failed", // a check suite on the head completed with failures (attempt n of CI_FIX_MAX_ATTEMPTS)
  "ci_passed", // CI went green (only delivered when it completes the "ready" picture, see `ready`)
  "review", // a review was submitted (approved / changes requested / commented)
  "comment", // a PR conversation comment or an inline review comment from an allowed author
  "conflict", // the PR is no longer mergeable against its base (base moved, or a lower stack PR merged)
  "base_changed", // the PR's base branch was edited (e.g. a stack parent merged and GitHub retargeted it)
  "ready", // CI green + approved (or no review required): the agent posts a standby note and goes idle
  "closed", // closed or merged: the subscription ended
]);
export type NotifyKind = z.infer<typeof notifyKind>;

/**
 * The text of a notification is rendered by the backend and written to Claude's stdin verbatim as a user turn, wrapped in one
 * envelope per delivery so the model (and the bridge's hooks) can tell autonomous turns from human ones:
 *
 *   <dorks-event source="github" kinds="ci_failed,comment" prs="owner/name#12">
 *   …digest and instructions…
 *   </dorks-event>
 */
export const NOTIFY_TAG = "dorks-event";

/** Which PR comment authors may wake a dork. `all` accepts anyone (the App's own comments are always dropped). */
export const commentPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  // GitHub logins, compared case-insensitively. Bots are listed by their login, e.g. `coderabbitai[bot]`.
  z.object({ mode: z.literal("allowlist"), logins: z.array(z.string()).max(200) }),
]);
export type CommentPolicy = z.infer<typeof commentPolicy>;
export const DEFAULT_COMMENT_POLICY: CommentPolicy = { mode: "all" };
