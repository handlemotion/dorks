import { ConvexError, v } from "convex/values";
import { aad, encrypt, keyringFromEnv } from "../../api/src/lib/crypto";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./auth";
import { fail } from "./lib/dispatch";
import { verifyInstallationOwnership } from "./lib/githubInstall";

export const MAX_CLAUDE_TOKEN_CHARS = 4 * 1024;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_SECRETS_PER_USER = 50;

const ring = () => keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! });

async function settingsRow(ctx: MutationCtx, userId: string) {
  const row = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (row) return row;
  const id = await ctx.db.insert("userSettings", { userId, sleepMinutes: 5 });
  return (await ctx.db.get(id))!;
}

/** Booleans only: ciphertext never leaves the backend. */
export const onboarding = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return { claudeToken: !!s?.claudeTokenEnc, github: !!s?.githubInstallationId, sleepMinutes: s?.sleepMinutes ?? 5 };
  },
});

/** Names only (sorted), for the settings screen: values and ciphertext never leave the backend. */
export const secretNames = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", userId)).collect();
    return rows.map((r) => r.name).sort();
  },
});

export const setClaudeToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireUserId(ctx);
    if (!token.trim()) throw new ConvexError({ code: "invalid", message: "empty token" });
    if (token.trim().length > MAX_CLAUDE_TOKEN_CHARS) throw new ConvexError({ code: "invalid", message: "token too long" });
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { claudeTokenEnc: (await encrypt(ring(), token.trim(), aad.claudeToken(userId))).value });
  },
});

export const setCliSecret = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    const userId = await requireUserId(ctx);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new ConvexError({ code: "invalid", message: "bad secret name" });
    if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) throw new ConvexError({ code: "invalid", message: "secret value too large" });
    const valueEnc = (await encrypt(ring(), value, aad.secret(userId, name))).value;
    const existing = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", userId).eq("name", name)).unique();
    if (existing) await ctx.db.patch(existing._id, { valueEnc });
    else {
      const held = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", userId)).take(MAX_SECRETS_PER_USER);
      if (held.length >= MAX_SECRETS_PER_USER) fail("limit", `at most ${MAX_SECRETS_PER_USER} secrets`);
      await ctx.db.insert("userSecrets", { userId, name, valueEnc });
    }
  },
});

/**
 * GitHub App install callback (OAuth-during-install). The client forwards the `code` and `installation_id` GitHub redirected
 * with; we only store the installation if that user's own token can see it. A bare id is never trusted, otherwise any user could
 * claim another org's installation and mint tokens for its repos.
 */
export const linkGithubInstallation = action({
  args: { installationId: v.number(), code: v.string() },
  handler: async (ctx, { installationId, code }) => {
    const userId = await requireUserId(ctx);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new ConvexError({ code: "invalid", message: "bad installation id" });
    // Local dev/e2e only (BOX_PROVIDER=sim, already the "no real GitHub App" switch in bridge.ts): code "sim" skips GitHub.
    const simulated = process.env.BOX_PROVIDER === "sim" && code === "sim";
    if (!simulated) {
      const clientId = process.env.GITHUB_APP_CLIENT_ID;
      const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new ConvexError({ code: "not_configured", message: "GitHub App OAuth is not configured" });
      let ok = false;
      try {
        ok = await verifyInstallationOwnership(code, installationId, { clientId, clientSecret });
      } catch (e) {
        console.error("github install verification failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
        throw new ConvexError({ code: "github_error", message: "could not verify the GitHub installation" });
      }
      if (!ok) throw new ConvexError({ code: "forbidden", message: "installation is not authorized for this GitHub account" });
    }
    await ctx.runMutation(internal.settings.storeGithubInstallation, { userId, installationId });
  },
});

export const storeGithubInstallation = internalMutation({
  args: { userId: v.string(), installationId: v.number() },
  handler: async (ctx, { userId, installationId }) => {
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { githubInstallationId: installationId });
  },
});

export const setSleepMinutes = mutation({
  args: { minutes: v.number() },
  handler: async (ctx, { minutes }) => {
    const userId = await requireUserId(ctx);
    // NaN slips through Math.min/max, then `runAfter(NaN)` throws inside bridge.push and wedges the dork in `working`.
    if (!Number.isFinite(minutes)) throw new ConvexError({ code: "invalid", message: "minutes must be a finite number" });
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { sleepMinutes: Math.min(Math.max(minutes, 0.05), 24 * 60) });
  },
});
