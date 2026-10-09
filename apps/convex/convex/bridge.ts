import { fromBridge, type ClientEventBody, type CommandFrame, type SubscriptionView, type ToBridge } from "@dorks/shared";
import { ConvexError, v } from "convex/values";
import { aad, decrypt, keyringFromEnv } from "../core/crypto";
import { agentTokenScope, createInstallationToken, GithubHttpError } from "../core/github";
import { createNormalizer } from "../core/normalize";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { verifyBridgeSecret } from "./lib/bridgeAuth";
import { append, bridgeSeen, dispatch, enqueueConfigure, finishPause, runtimeOf, setTimer } from "./lib/dispatch";
import * as subs from "./lib/subscriptions";

// The in-box bridge speaks packages/shared/src/bridge.ts through these functions instead of a WebSocket:
//   subscribe  `commands`   <- DO->bridge frames (user_message / notify / interrupt / flush; configure & gh_token as fetch markers)
//   mutation   `push`       -> bridge->DO frames (event / ready / ack / agent_exited / flushed), batched
//   mutation   `connect`    -> "hello" + queues a configure;  mutation `heartbeat` -> liveness
//   action     `configure` / `ghToken` -> the only places secrets are decrypted and handed out.
// Every call carries the per-dork secret the box was created with (see lib/bridgeAuth.ts).

async function authed(ctx: QueryCtx, dorkId: Id<"dorks">, secret: string): Promise<Doc<"dorks">> {
  const dork = await ctx.db.get(dorkId);
  if (!dork || dork.deleting || !(await verifyBridgeSecret(dorkId, secret))) throw new ConvexError({ code: "forbidden", message: "forbidden" });
  return dork;
}

const creds = { dorkId: v.id("dorks"), secret: v.string() };

export const connect = mutation({
  args: creds,
  handler: async (ctx, { dorkId, secret }) => {
    const dork = await authed(ctx, dorkId, secret);
    // A bridge that connects while we believe the box is asleep must not wake anything.
    if (dork.state === "sleeping") throw new ConvexError({ code: "sleeping", message: "sleeping" });
    await bridgeSeen(ctx, dork);
    await enqueueConfigure(ctx, dorkId);
    return { afterBridgeSeq: (await runtimeOf(ctx, dorkId)).bridgeSeq };
  },
});

export const commands = query({
  args: creds,
  handler: async (ctx, { dorkId, secret }): Promise<{ cid: string; frame: CommandFrame }[]> => {
    const dork = await authed(ctx, dorkId, secret);
    if (dork.state === "sleeping") return [];
    // Before `ready` the agent is not up. And once the box call of a pause is in flight (or was cancelled but still lands), a
    // delivered message could be acked and then lost with the box: hold it back, the re-wake after the pause delivers it.
    const rt = await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique();
    const deliverMessages = (dork.state === "working" || dork.state === "idle") && (!rt?.pause || rt.pause.phase === "flushing");
    const open = await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId).eq("acked", false)).collect();
    // User messages always go first: no notify is emitted while one is unacked. A notify that arrived mid-turn stays held
    // (`released` false) until the machine's release_notify, so a turn is never interrupted by an autonomous event.
    const userPending = open.some((c) => c.kind === "user_message");
    const out: { cid: string; frame: CommandFrame }[] = [];
    for (const c of open) {
      if (c.kind === "user_message") {
        if (deliverMessages) out.push({ cid: c.cid, frame: { t: "user_message", id: c.cid, text: c.text! } });
      } else if (c.kind === "notify") {
        if (deliverMessages && !userPending && (dork.state === "idle" || c.released))
          out.push({ cid: c.cid, frame: { t: "notify", id: c.cid, text: c.text!, kinds: c.meta!.kinds, prs: c.meta!.prs } });
      } else if (c.kind === "configure") out.push({ cid: c.cid, frame: { t: "fetch_configure" } });
      else if (c.kind === "gh_token") out.push({ cid: c.cid, frame: { t: "fetch_gh_token" } });
      else out.push({ cid: c.cid, frame: { t: c.kind } });
    }
    return out;
  },
});

export const heartbeat = mutation({
  args: creds,
  handler: async (ctx, { dorkId, secret }) => {
    const dork = await authed(ctx, dorkId, secret);
    await bridgeSeen(ctx, dork); // back after a blip while working/idle cancels the watchdog the loss armed
  },
});

// Per-call limits (H9): one push is one transaction, and a hostile or buggy bridge must not be able to fill it.
export const MAX_FRAMES_PER_PUSH = 500;
export const MAX_EVENT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/**
 * Bridge -> backend frames, batched. Events must arrive numbered exactly `bridgeSeq + 1`, `+ 2`, ... (anything `<= bridgeSeq` is a
 * replay and is skipped). If the call contains a gap, NOTHING in it is applied and the result is `{ ok: false, expectedBseq }`
 * (`bridgeSeq + 1`): the bridge must resend everything from its event `expectedBseq` on. Otherwise the result is `{ ok: true }`.
 * Too many frames or an oversized event reject the whole call with a ConvexError (`too_many_frames` / `event_too_large`).
 */
export const push = mutation({
  args: { ...creds, frames: v.array(v.any()) },
  handler: async (ctx, { dorkId, secret, frames }): Promise<{ ok: true } | { ok: false; expectedBseq: number }> => {
    const dork = await authed(ctx, dorkId, secret);
    if (frames.length > MAX_FRAMES_PER_PUSH) throw new ConvexError({ code: "too_many_frames", message: `at most ${MAX_FRAMES_PER_PUSH} frames per push` });
    for (const raw of frames) {
      const payload = (raw as { raw?: unknown } | null)?.raw;
      if (payload !== undefined && encoder.encode(JSON.stringify(payload)).length > MAX_EVENT_BYTES) {
        throw new ConvexError({ code: "event_too_large", message: `an event exceeds ${MAX_EVENT_BYTES} bytes` });
      }
    }
    await bridgeSeen(ctx, dork); // liveness counts even when the batch is refused below
    const rt = await runtimeOf(ctx, dorkId);
    let { bridgeSeq, streamMsgId } = rt;

    // Validate the whole batch before applying any of it: events must continue the stored numbering exactly (frames already
    // stored are skipped as replays). A gap refuses the call atomically, so the bridge can resend everything after its last
    // confirmed event without any frame (an `agent_exited`, say) being applied twice.
    const parsedFrames = frames.flatMap((raw) => {
      const parsed = fromBridge.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    let next = bridgeSeq + 1;
    for (const f of parsedFrames) {
      if (f.t !== "event" || f.bseq < next) continue;
      if (f.bseq !== next) return { ok: false, expectedBseq: bridgeSeq + 1 };
      next++;
    }
    // The normalizer is stateful (in-flight message id) but a mutation is not: seed it from the last batch.
    const normalize = createNormalizer();
    if (streamMsgId) normalize({ type: "stream_event", event: { type: "message_start", message: { id: streamMsgId } } });

    const pending: ClientEventBody[] = [];
    const flush = async () => {
      if (pending.length) await append(ctx, dorkId, ...pending.splice(0));
    };
    let preview: string | undefined;
    let touched = false;

    for (const f of parsedFrames) {
      switch (f.t) {
        case "event": {
          if (f.bseq <= bridgeSeq) break; // replay overlap after a reconnect
          bridgeSeq = f.bseq;
          const r = f.raw as { type?: string; event?: { type?: string; message?: { id?: string } } };
          if (r?.type === "stream_event" && r.event?.type === "message_start") streamMsgId = r.event.message?.id ?? "";
          for (const n of normalize(f.raw)) {
            if (n.kind === "event") {
              pending.push(n.body);
              if (n.body.type === "assistant_message") preview = n.body.text.slice(0, 140);
              if (n.body.type === "turn_complete") touched = true;
            } else if (n.kind === "session") {
              await ctx.db.patch(dorkId, { claudeSessionId: n.sessionId });
            } else {
              await flush();
              await dispatch(ctx, dorkId, { t: "turn_idle" });
            }
          }
          break;
        }
        case "ready":
          await flush();
          await dispatch(ctx, dorkId, { t: "agent_ready" });
          break;
        case "ack": {
          const open = await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId).eq("acked", false)).collect();
          const c = open.find((x) => x.cid === f.id);
          if (!c) break;
          if (c.kind === "user_message" || c.kind === "notify") await ctx.db.patch(c._id, { acked: true });
          else await ctx.db.delete(c._id);
          break;
        }
        case "agent_exited":
          await flush();
          await append(ctx, dorkId, { type: "agent_exited", message: `agent exited (code ${f.code ?? "?"})` });
          console.error("agent exited", dorkId, f.code); // stderr tail is never logged: it can echo env
          await dispatch(ctx, dorkId, { t: "agent_exited" });
          break;
        case "flushed":
          await finishPause(ctx, dorkId, f.cid);
          break;
      }
    }
    await flush();
    await ctx.db.patch(rt._id, { bridgeSeq, streamMsgId });
    if (preview !== undefined || touched) await ctx.db.patch(dorkId, { ...(preview !== undefined ? { preview } : {}), lastActivityAt: Date.now() });
    return { ok: true };
  },
});

// ---------------------------------------------------------------- PR subscriptions (docs/autonomy.md)
// The gh shim / hooks / `dorks pr` CLI in the box call these through the bridge. Webhook events for a subscribed PR then reach the agent as `notify` frames.

/** Idempotent. The PR's metadata is filled in asynchronously from GitHub (subscriptions.hydrate). */
export const subscribe = mutation({
  args: { ...creds, repo: v.string(), number: v.number(), source: v.union(v.literal("auto"), v.literal("agent")) },
  handler: async (ctx, { dorkId, secret, repo, number, source }) => {
    await subs.subscribe(ctx, await authed(ctx, dorkId, secret), repo, number, source);
  },
});

export const unsubscribe = mutation({
  args: { ...creds, repo: v.string(), number: v.number() },
  handler: async (ctx, { dorkId, secret, repo, number }) => {
    await authed(ctx, dorkId, secret);
    await subs.unsubscribe(ctx, dorkId, repo, number);
  },
});

/** Reactive: the bridge caches this for its hooks and the `dorks pr list` CLI. */
export const subscriptions = query({
  args: creds,
  handler: async (ctx, { dorkId, secret }): Promise<SubscriptionView[]> => {
    await authed(ctx, dorkId, secret);
    return (await subs.subscriptionsOfDork(ctx, dorkId)).filter((s) => s.status !== "ended").map(subs.toView);
  },
});

// ---------------------------------------------------------------- secrets: actions only
/** Secrets are only minted for a dork whose box should be up and which the user has not archived. */
const TOKEN_STATES = ["creating", "waking", "working", "idle"];
export const mayMintSecrets = (dork: Pick<Doc<"dorks">, "state" | "archived">) => !dork.archived && TOKEN_STATES.includes(dork.state);

/**
 * A failed token refresh must not wait for the next 45-minute tick (the 60-minute token would expire first), but it must not hammer
 * GitHub either: retry only transient failures, with exponential backoff, and tell the user once if it keeps failing.
 */
export const GH_RETRY_MS = 2 * 60_000;
export const GH_RETRY_MAX_MS = 10 * 60_000;
export const GH_FAILURES_BEFORE_NOTICE = 3;
export const ghRetryDelay = (failures: number) => Math.min(GH_RETRY_MS * 2 ** (failures - 1), GH_RETRY_MAX_MS);
/** 5xx, rate limiting or a network error: worth retrying. 4xx/config errors will not fix themselves in two minutes. */
export const isTransientGithubError = (e: unknown) => (e instanceof GithubHttpError ? e.status >= 500 || e.status === 429 : e instanceof TypeError);

/** Null = refused (wrong state or archived): the caller hands out nothing. */
export const configInfo = internalQuery({
  args: creds,
  handler: async (ctx, { dorkId, secret }) => {
    const dork = await authed(ctx, dorkId, secret);
    if (!mayMintSecrets(dork)) return null;
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", dork.userId)).unique();
    const secrets = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", dork.userId)).collect();
    return {
      userId: dork.userId, repo: dork.repo, branch: dork.branch, resumeSessionId: dork.claudeSessionId ?? null,
      ghFailures: (await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique())?.ghFailures ?? 0,
      claudeTokenEnc: s?.claudeTokenEnc ?? null, githubInstallationId: s?.githubInstallationId ?? null,
      secrets: secrets.map((x) => ({ name: x.name, valueEnc: x.valueEnc })),
    };
  },
});

const ring = () => keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! });

/**
 * The box runs untrusted agent code, so the token is limited to the permissions in `AGENT_TOKEN_PERMISSIONS` (github.ts). It is not
 * limited to one repo: the agent may work in any repo the installation reaches (docs/autonomy.md).
 */
async function githubToken(info: { githubInstallationId: number | null }): Promise<string> {
  if (!info.githubInstallationId) throw new OnboardingError("GitHub App not installed");
  if (process.env.BOX_PROVIDER === "sim") return "sim-github-token"; // local dev: no real GitHub App
  const env = { GITHUB_APP_ID: process.env.GITHUB_APP_ID!, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY! };
  try {
    return (await createInstallationToken(env, info.githubInstallationId, fetch, agentTokenScope())).token;
  } catch (e) {
    // 422: the App (or this installation, which must accept new permissions) lacks a permission we ask for. 404: the installation is gone.
    if (e instanceof GithubHttpError && e.status === 422) throw new OnboardingError("GitHub App permissions are out of date; accept the new permissions on the installation");
    if (e instanceof GithubHttpError && e.status === 404) throw new OnboardingError("GitHub App installation not found; install the App again");
    throw e;
  }
}
class OnboardingError extends Error {}

/** Returns the `configure` frame (Claude token + CLI secrets + GitHub token) straight to the authenticated bridge: never stored, never in a query. */
export const configure = action({
  args: creds,
  handler: async (ctx, args): Promise<ToBridge | null> => {
    const info = await ctx.runQuery(internal.bridge.configInfo, args);
    if (!info) {
      console.error("configure refused", args.dorkId);
      // Archived while the box was still booting: the bridge will never report `ready` now, so let the machine's own
      // archived -> idle + pause_box path run instead of leaving the box up until the watchdog.
      await ctx.runMutation(internal.bridge.settleRefused, { dorkId: args.dorkId });
      return null;
    }
    let cfg: ToBridge;
    try {
      if (!info.claudeTokenEnc) throw new OnboardingError("Claude token not set");
      const cliSecrets: Record<string, string> = {};
      for (const r of info.secrets) cliSecrets[r.name] = await decrypt(ring(), r.valueEnc, aad.secret(info.userId, r.name));
      cfg = {
        t: "configure",
        env: { ...cliSecrets, CLAUDE_CODE_OAUTH_TOKEN: await decrypt(ring(), info.claudeTokenEnc, aad.claudeToken(info.userId)) },
        ghToken: await githubToken(info),
        repo: { fullName: info.repo, branch: info.branch },
        resumeSessionId: info.resumeSessionId,
      };
    } catch (e) {
      const message = e instanceof OnboardingError ? e.message : "could not configure the sandbox";
      console.error("configure failed", args.dorkId, e instanceof OnboardingError ? e.message : "unexpected");
      await ctx.runMutation(internal.lifecycle.opFailed, { dorkId: args.dorkId, message });
      return null;
    }
    if (info.ghFailures) await ctx.runMutation(internal.bridge.ghTokenRecovered, { dorkId: args.dorkId });
    return cfg;
  },
});

export const ghToken = action({
  args: creds,
  handler: async (ctx, args): Promise<ToBridge | null> => {
    const info = await ctx.runQuery(internal.bridge.configInfo, args);
    if (!info) {
      console.error("gh token refused", args.dorkId);
      return null;
    }
    try {
      const token = await githubToken(info);
      if (info.ghFailures) await ctx.runMutation(internal.bridge.ghTokenRecovered, { dorkId: args.dorkId });
      return { t: "gh_token", token };
    } catch (e) {
      console.error("gh token refresh failed", args.dorkId, e instanceof GithubHttpError ? e.status : e instanceof OnboardingError ? "onboarding" : "unexpected");
      // The old token stays valid for a while. Only the failure is recorded here; retry/notice policy lives in ghTokenFailed.
      await ctx.runMutation(internal.bridge.ghTokenFailed, {
        dorkId: args.dorkId, transient: isTransientGithubError(e), detail: e instanceof OnboardingError ? e.message : undefined,
      });
      return null;
    }
  },
});

const liveStates = (s: string) => s === "working" || s === "idle";

/**
 * Records a failed refresh. Transient failures re-arm the `gh_token` timer with exponential backoff (2, 4, 8, 10, 10… minutes; the timer
 * handler then queues a fresh marker and re-arms the normal 45-minute tick). Permanent ones (installation removed, repo deselected, bad
 * key) are not retried early. Either way the user gets one error event once it is clear the token will lapse.
 */
export const ghTokenFailed = internalMutation({
  args: { dorkId: v.id("dorks"), transient: v.boolean(), detail: v.optional(v.string()) },
  handler: async (ctx, { dorkId, transient, detail }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting || dork.archived || !liveStates(dork.state)) return;
    const rt = await runtimeOf(ctx, dorkId);
    const before = rt.ghFailures ?? 0;
    const failures = transient ? before + 1 : Math.max(before + 1, GH_FAILURES_BEFORE_NOTICE);
    await ctx.db.patch(rt._id, { ghFailures: failures });
    if (before < GH_FAILURES_BEFORE_NOTICE && failures >= GH_FAILURES_BEFORE_NOTICE) {
      await append(ctx, dorkId, { type: "error", message: `GitHub access is failing${detail ? `: ${detail}` : ""}. Pushing and opening PRs will stop working when the current token expires.` });
    }
    if (transient) await setTimer(ctx, dorkId, "gh_token", ghRetryDelay(failures));
  },
});

export const ghTokenRecovered = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const rt = await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique();
    if (rt?.ghFailures) await ctx.db.patch(rt._id, { ghFailures: 0 });
  },
});

/** `configure` was refused. If the dork was archived while still booting, finish the boot handshake so the box is paused, not left running. */
export const settleRefused = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const dork = await ctx.db.get(dorkId);
    if (dork && !dork.deleting && dork.archived && (dork.state === "creating" || dork.state === "waking")) await dispatch(ctx, dorkId, { t: "agent_ready" });
  },
});
