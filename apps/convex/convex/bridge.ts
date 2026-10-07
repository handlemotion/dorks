import { fromBridge, type ClientEventBody, type CommandFrame, type ToBridge } from "@dorks/shared";
import { ConvexError, v } from "convex/values";
import { aad, decrypt, keyringFromEnv } from "../../api/src/lib/crypto";
import { agentTokenScope, createInstallationToken } from "../../api/src/lib/github";
import { createNormalizer } from "../../api/src/normalize";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { verifyBridgeSecret } from "./lib/bridgeAuth";
import { append, dispatch, enqueueConfigure, finishPause, runtimeOf, setTimer } from "./lib/dispatch";

// The in-box bridge speaks packages/shared/src/bridge.ts through these functions instead of a WebSocket:
//   subscribe  `commands`   <- DO->bridge frames (user_message / interrupt / flush; configure & gh_token as fetch markers)
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
    const rt = await runtimeOf(ctx, dorkId);
    await ctx.db.patch(rt._id, { bridgeSeenAt: Date.now(), bridgeLost: false });
    await enqueueConfigure(ctx, dorkId);
    return { afterBridgeSeq: rt.bridgeSeq };
  },
});

export const commands = query({
  args: creds,
  handler: async (ctx, { dorkId, secret }): Promise<{ cid: string; frame: CommandFrame }[]> => {
    const dork = await authed(ctx, dorkId, secret);
    if (dork.state === "sleeping") return [];
    const deliverMessages = dork.state === "working" || dork.state === "idle"; // before `ready` the agent is not up
    const open = await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId).eq("acked", false)).collect();
    const out: { cid: string; frame: CommandFrame }[] = [];
    for (const c of open) {
      if (c.kind === "user_message") {
        if (deliverMessages) out.push({ cid: c.cid, frame: { t: "user_message", id: c.cid, text: c.text! } });
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
    const rt = await runtimeOf(ctx, dorkId);
    await ctx.db.patch(rt._id, { bridgeSeenAt: Date.now(), bridgeLost: false });
    // Back after a blip while working/idle: same path as the old "agent_ready after reconnect" (cancels the watchdog).
    if (rt.bridgeLost && (dork.state === "working" || dork.state === "idle")) await dispatch(ctx, dorkId, { t: "agent_ready" });
  },
});

export const push = mutation({
  args: { ...creds, frames: v.array(v.any()) },
  handler: async (ctx, { dorkId, secret, frames }) => {
    await authed(ctx, dorkId, secret);
    const rt = await runtimeOf(ctx, dorkId);
    let { bridgeSeq, streamMsgId } = rt;
    // The normalizer is stateful (in-flight message id) but a mutation is not: seed it from the last batch.
    const normalize = createNormalizer();
    if (streamMsgId) normalize({ type: "stream_event", event: { type: "message_start", message: { id: streamMsgId } } });

    const pending: ClientEventBody[] = [];
    const flush = async () => {
      if (pending.length) await append(ctx, dorkId, ...pending.splice(0));
    };
    let preview: string | undefined;
    let touched = false;

    for (const raw of frames) {
      const parsed = fromBridge.safeParse(raw);
      if (!parsed.success) continue;
      const f = parsed.data;
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
          if (c.kind === "user_message") await ctx.db.patch(c._id, { acked: true });
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
          await finishPause(ctx, dorkId);
          break;
      }
    }
    await flush();
    await ctx.db.patch(rt._id, { bridgeSeq, streamMsgId, bridgeSeenAt: Date.now(), bridgeLost: false });
    if (preview !== undefined || touched) await ctx.db.patch(dorkId, { ...(preview !== undefined ? { preview } : {}), lastActivityAt: Date.now() });
  },
});

// ---------------------------------------------------------------- secrets: actions only
/** Secrets are only minted for a dork whose box should be up and which the user has not archived. */
const TOKEN_STATES = ["creating", "waking", "working", "idle"];
export const mayMintSecrets = (dork: Pick<Doc<"dorks">, "state" | "archived">) => !dork.archived && TOKEN_STATES.includes(dork.state);

/** A failed token refresh must not wait for the next 45-minute tick: the 60-minute token would expire first. */
export const GH_RETRY_MS = 2 * 60_000;

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
      claudeTokenEnc: s?.claudeTokenEnc ?? null, githubInstallationId: s?.githubInstallationId ?? null,
      secrets: secrets.map((x) => ({ name: x.name, valueEnc: x.valueEnc })),
    };
  },
});

const ring = () => keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! });

/** The box runs untrusted agent code, so the token is limited to this dork's repo and to push + PR permissions (see github.ts). */
async function githubToken(info: { githubInstallationId: number | null; repo: string }): Promise<string> {
  if (!info.githubInstallationId) throw new OnboardingError("GitHub App not installed");
  if (process.env.BOX_PROVIDER === "sim") return "sim-github-token"; // local dev: no real GitHub App
  const env = { GITHUB_APP_ID: process.env.GITHUB_APP_ID!, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY! };
  return (await createInstallationToken(env, info.githubInstallationId, fetch, agentTokenScope(info.repo))).token;
}
class OnboardingError extends Error {}

/** Returns the `configure` frame (Claude token + CLI secrets + GitHub token) straight to the authenticated bridge: never stored, never in a query. */
export const configure = action({
  args: creds,
  handler: async (ctx, args): Promise<ToBridge | null> => {
    const info = await ctx.runQuery(internal.bridge.configInfo, args);
    if (!info) {
      console.error("configure refused", args.dorkId);
      return null;
    }
    try {
      if (!info.claudeTokenEnc) throw new OnboardingError("Claude token not set");
      const cliSecrets: Record<string, string> = {};
      for (const r of info.secrets) cliSecrets[r.name] = await decrypt(ring(), r.valueEnc, aad.secret(info.userId, r.name));
      return {
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
      return { t: "gh_token", token: await githubToken(info) };
    } catch {
      console.error("gh token refresh failed", args.dorkId);
      await ctx.runMutation(internal.bridge.retryGhToken, { dorkId: args.dorkId }); // the old token is still valid for a while: try again soon
      return null;
    }
  },
});

/** Re-arms the `gh_token` timer to fire in ~2 minutes (the timer handler then queues a fresh marker and re-arms the normal 45-minute tick). */
export const retryGhToken = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting || dork.archived || (dork.state !== "working" && dork.state !== "idle")) return;
    await setTimer(ctx, dorkId, "gh_token", GH_RETRY_MS);
  },
});
