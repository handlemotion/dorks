import { ConvexError, v } from "convex/values";
import { aad, encrypt, keyringFromEnv } from "../../api/src/lib/crypto";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./auth";

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

export const setClaudeToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireUserId(ctx);
    if (!token.trim()) throw new ConvexError({ code: "invalid", message: "empty token" });
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { claudeTokenEnc: (await encrypt(ring(), token.trim(), aad.claudeToken(userId))).value });
  },
});

export const setCliSecret = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    const userId = await requireUserId(ctx);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new ConvexError({ code: "invalid", message: "bad secret name" });
    const valueEnc = (await encrypt(ring(), value, aad.secret(userId, name))).value;
    const existing = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", userId).eq("name", name)).unique();
    if (existing) await ctx.db.patch(existing._id, { valueEnc });
    else await ctx.db.insert("userSecrets", { userId, name, valueEnc });
  },
});

/** Stand-in for the GitHub App install callback. */
export const setGithubInstallation = mutation({
  args: { installationId: v.number() },
  handler: async (ctx, { installationId }) => {
    const row = await settingsRow(ctx, await requireUserId(ctx));
    await ctx.db.patch(row._id, { githubInstallationId: installationId });
  },
});

export const setSleepMinutes = mutation({
  args: { minutes: v.number() },
  handler: async (ctx, { minutes }) => {
    const row = await settingsRow(ctx, await requireUserId(ctx));
    await ctx.db.patch(row._id, { sleepMinutes: Math.min(Math.max(minutes, 0.05), 24 * 60) });
  },
});
