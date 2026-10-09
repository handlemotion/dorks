import { v } from "convex/values";

export const dorkState = v.union(v.literal("creating"), v.literal("working"), v.literal("idle"), v.literal("sleeping"), v.literal("waking"), v.literal("error"));

// Convex mirrors of the shared zod enums (packages/shared/src/autonomy.ts). `lib/subscriptions.ts toView` fails to typecheck if they drift.
export const subscriptionSource = v.union(v.literal("auto"), v.literal("agent"), v.literal("user"));
export const subscriptionStatus = v.union(v.literal("active"), v.literal("stalled"), v.literal("ended"));
export const ciState = v.union(v.literal("unknown"), v.literal("pending"), v.literal("passing"), v.literal("failing"));
export const reviewState = v.union(v.literal("none"), v.literal("commented"), v.literal("changes_requested"), v.literal("approved"));
export const notifyKind = v.union(
  v.literal("ci_failed"), v.literal("ci_passed"), v.literal("review"), v.literal("comment"),
  v.literal("conflict"), v.literal("base_changed"), v.literal("ready"), v.literal("closed"),
);
export const prRef = v.object({ repo: v.string(), number: v.number() });
export const commentPolicy = v.union(v.object({ mode: v.literal("all") }), v.object({ mode: v.literal("allowlist"), logins: v.array(v.string()) }));
