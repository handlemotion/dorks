import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { ciState, commentPolicy, dorkState, notifyKind, prRef, reviewState, subscriptionSource, subscriptionStatus } from "./validators";

export default defineSchema({
  // Encrypted at rest (AES-GCM envelope, key in env). Never returned by any query.
  userSettings: defineTable({
    userId: v.string(),
    claudeTokenEnc: v.optional(v.string()),
    githubInstallationId: v.optional(v.number()),
    githubLogin: v.optional(v.string()), // the installing user's GitHub login (captured at install-link time): their comments always wake their dorks
    commentPolicy: v.optional(commentPolicy), // absent = DEFAULT_COMMENT_POLICY
    workstationSnapshotId: v.optional(v.string()),
    sleepMinutes: v.number(),
  }).index("by_user", ["userId"]),
  userSecrets: defineTable({
    userId: v.string(),
    name: v.string(),
    valueEnc: v.string(),
  }).index("by_user_name", ["userId", "name"]),

  // Client-visible row (list + header of the thread view). Nothing here changes per delta, so subscriptions stay quiet mid-turn.
  dorks: defineTable({
    userId: v.string(),
    title: v.string(),
    repo: v.string(),
    branch: v.string(),
    state: dorkState,
    archived: v.boolean(),
    boxId: v.optional(v.string()),
    claudeSessionId: v.optional(v.string()),
    preview: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    deleting: v.optional(v.boolean()),
    lastActivityAt: v.number(),
  })
    .index("by_user_activity", ["userId", "lastActivityAt"])
    .index("by_user_archived_activity", ["userId", "archived", "lastActivityAt"]),

  // Server-only bookkeeping, one row per dork. Never exposed to clients.
  dorkRuntime: defineTable({
    dorkId: v.id("dorks"),
    bridgeSeq: v.number(), // last bridge event number stored (replaces `meta.bridge_seq`)
    streamMsgId: v.string(), // normalizer carry-over between batches
    sleepMinutes: v.number(),
    bridgeSeenAt: v.number(),
    bridgeLost: v.boolean(),
    ghFailures: v.optional(v.number()), // consecutive failed GitHub token refreshes (bridge.ts); absent/0 = healthy
    timers: v.record(v.string(), v.id("_scheduled_functions")), // name -> pending scheduled run (sleep | watchdog | gh_token | bridge_watch | flush | notify)
    // Box-operation generation. Bumped whenever a create/resume/pause is launched; the box actions carry it back so a result
    // from a superseded operation (a resume that lost to a pause, a create that was retried) cannot move a newer attempt.
    opGen: v.optional(v.number()),
    // The active intent to pause the box, if any. `flushing`: waiting for the bridge's `flushed` (for `flushCid`); `pausing`:
    // boxes.pause is in flight (`since` bounds how long we trust that); `cancelled`: a message arrived while it was in flight
    // (the pause will still land, so the dork must wake again).
    pause: v.optional(v.object({
      gen: v.number(),
      phase: v.union(v.literal("flushing"), v.literal("pausing"), v.literal("cancelled")),
      since: v.optional(v.number()),
      flushCid: v.optional(v.string()),
    })),
    pauseRetries: v.optional(v.number()), // failed pauses retried from `error` (capped, reset when a pause lands or a new op starts)
  }).index("by_dork", ["dorkId"]),

  // Append-only per-dork log. `seq` is dense per dork (1..n); that is the only ordering clients need.
  events: defineTable({
    dorkId: v.id("dorks"),
    seq: v.number(),
    ts: v.number(),
    body: v.any(), // ClientEventBody. Not validated at runtime: `append` takes it type-checked only, and bridge frames are parsed at the bridge boundary. packages/shared/src/events.test.ts guards the schema; normalize.test.ts checks normalizer output against it.
  }).index("by_dork_seq", ["dorkId", "seq"]),

  // Durable outbox + control frames for the bridge. Holds no secrets: `configure`/`gh_token` are markers that
  // make the bridge call an action, which returns the secrets over the authenticated call (never stored/queried).
  commands: defineTable({
    dorkId: v.id("dorks"),
    kind: v.union(v.literal("user_message"), v.literal("notify"), v.literal("configure"), v.literal("gh_token"), v.literal("interrupt"), v.literal("flush")),
    cid: v.string(), // command id the bridge acks (user_message / notify id is what bridge dedupes on)
    text: v.optional(v.string()),
    // notify only: what the envelope in `text` contains (the frame's metadata), and whether it may be emitted while a turn runs.
    // A notify that arrives mid-turn is held (`released` false) until a turn ends with no user message waiting (machine: release_notify).
    meta: v.optional(v.object({ kinds: v.array(notifyKind), prs: v.array(prRef) })),
    released: v.optional(v.boolean()),
    acked: v.boolean(),
  }).index("by_dork_acked", ["dorkId", "acked"]),

  // A dork's subscription to a PR (docs/autonomy.md). Several dorks may subscribe to one PR; maps 1:1 onto `subscriptionView`.
  // `repo` is stored lowercase (GitHub repo names are case-insensitive; see lib/repo.ts) so the webhook indexes match.
  prSubscriptions: defineTable({
    dorkId: v.id("dorks"),
    userId: v.string(),
    repo: v.string(),
    number: v.number(),
    url: v.string(),
    title: v.optional(v.string()),
    headRef: v.optional(v.string()),
    baseRef: v.optional(v.string()),
    headSha: v.optional(v.string()),
    source: subscriptionSource,
    status: subscriptionStatus,
    ci: ciState,
    review: reviewState,
    mergeable: v.union(v.boolean(), v.null()),
    ciFixAttempts: v.number(),
    state: v.union(v.literal("open"), v.literal("closed"), v.literal("merged")),
    lastEventAt: v.number(),
    // Webhook bookkeeping (lib/githubIngest.ts), not part of `subscriptionView`.
    ciFailing: v.optional(v.array(v.number())), // check suites of the current head that failed and have not passed since
    ciNotified: v.optional(v.boolean()), // a `ci_failed` for the current head was queued: the next push counts as a fix attempt
    readySha: v.optional(v.string()), // head SHA a `ready` was already queued for
    conflictSha: v.optional(v.string()), // base SHA a `conflict` was already queued for
  })
    .index("by_repo_number", ["repo", "number"])
    .index("by_repo_head", ["repo", "headRef"]) // check events carry a SHA or branch, not a PR number
    .index("by_repo_base", ["repo", "baseRef"]) // pushes to a base branch re-check every PR that targets it
    .index("by_dork", ["dorkId", "repo", "number"]),

  // Debounce buffer between the webhook and the agent: one row per notable event, folded into one `notify` command by the
  // per-dork `notify` timer (lib/notify.ts). `delivered` rows are kept briefly, then swept.
  inbox: defineTable({
    dorkId: v.id("dorks"),
    subscriptionId: v.id("prSubscriptions"),
    kind: notifyKind,
    summary: v.string(),
    deliveryId: v.optional(v.string()), // X-GitHub-Delivery that produced it
    createdAt: v.number(),
    delivered: v.boolean(),
  })
    .index("by_dork_delivered", ["dorkId", "delivered"])
    .index("by_delivered_created", ["delivered", "createdAt"]),

  // X-GitHub-Delivery ids already handled (webhook dedupe). Pruned by cron.
  githubDeliveries: defineTable({ deliveryId: v.string(), receivedAt: v.number() })
    .index("by_delivery", ["deliveryId"])
    .index("by_received", ["receivedAt"]),

  // Fixed-window counters for sign-in rate limiting (see rateLimit.ts). `key` embeds the limited thing (email or IP).
  rateLimits: defineTable({ key: v.string(), windowStart: v.number(), count: v.number() })
    .index("by_key", ["key"])
    .index("by_window_start", ["windowStart"]),

  // Dev/sim only: what a real BoxProvider (Upstash) would hold remotely.
  simBoxes: defineTable({ name: v.string(), running: v.boolean(), gen: v.number(), costMicro: v.optional(v.number()) }).index("by_name", ["name"]),

  // Stripe billing (docs/billing.md): one flat monthly subscription per user. One row per user once they start Checkout; `status` mirrors the Stripe subscription.
  billing: defineTable({
    userId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.optional(v.string()),
    status: v.string(), // Stripe subscription status (active, trialing, past_due, canceled, ...) or "none" before the first subscription
    currentPeriodEnd: v.optional(v.number()), // ms
    cancelAtPeriodEnd: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_customer", ["stripeCustomerId"]),

  // Stripe event ids already handled (webhook dedupe). Pruned by cron.
  stripeEvents: defineTable({ eventId: v.string(), receivedAt: v.number() })
    .index("by_event", ["eventId"])
    .index("by_received", ["receivedAt"]),
});
