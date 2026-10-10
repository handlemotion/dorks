import { commentPolicy as commentPolicySchema, DEFAULT_COMMENT_POLICY } from "@dorks/shared";
import { v } from "convex/values";
import { aad, decrypt, encrypt, keyringFromEnv } from "../core/crypto";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./auth";
import { fail } from "./lib/dispatch";
import { verifyInstallationOwnership } from "./lib/githubInstall";
import { verifyUpstashKey, WorkstationBuildError } from "./lib/workstationBuild";

export const MAX_CLAUDE_TOKEN_CHARS = 4 * 1024;
export const MAX_UPSTASH_KEY_CHARS = 512;
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
    return {
      claudeToken: !!s?.claudeTokenEnc, upstashKey: !!s?.upstashKeyEnc, workstation: s?.workstationStatus ?? "none", workstationError: s?.workstationError ?? null,
      github: !!s?.githubInstallationId, sleepMinutes: s?.sleepMinutes ?? 5, commentPolicy: s?.commentPolicy ?? DEFAULT_COMMENT_POLICY,
    };
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
    if (!token.trim()) fail("invalid", "empty token");
    if (token.trim().length > MAX_CLAUDE_TOKEN_CHARS) fail("invalid", "token too long");
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { claudeTokenEnc: (await encrypt(ring(), token.trim(), aad.claudeToken(userId))).value });
  },
});

/** Ciphertext for the box actions (internal only: public functions never return it). */
export const upstashKeyEnc = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return s?.upstashKeyEnc ?? null;
  },
});

/**
 * Bring your own Upstash: the user's Box API key (console.upstash.com -> Box). Checked against Upstash before it is stored, then encrypted
 * like the Claude token. Their dork boxes run in their account and on their bill. A different key means a different account, so the
 * workstation image (which lives in the old account) is forgotten and has to be built again.
 */
export const setUpstashKey = action({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await requireUserId(ctx);
    const trimmed = key.trim();
    if (!trimmed) fail("invalid", "empty key");
    if (trimmed.length > MAX_UPSTASH_KEY_CHARS) fail("invalid", "key too long");
    try {
      await verifyUpstashKey({ apiKey: trimmed, baseUrl: process.env.UPSTASH_BOX_BASE_URL || undefined });
    } catch (e) {
      fail("invalid", e instanceof WorkstationBuildError ? e.message : "could not check the Upstash key");
    }
    const valueEnc = (await encrypt(ring(), trimmed, aad.upstashKey(userId))).value;
    await ctx.runMutation(internal.settings.storeUpstashKey, { userId, valueEnc });
  },
});

export const storeUpstashKey = internalMutation({
  args: { userId: v.string(), valueEnc: v.string() },
  handler: async (ctx, { userId, valueEnc }) => {
    const row = await settingsRow(ctx, userId);
    const same = row.upstashKeyEnc !== undefined && (await decrypt(ring(), row.upstashKeyEnc, aad.upstashKey(userId)).catch(() => null)) === (await decrypt(ring(), valueEnc, aad.upstashKey(userId)));
    await ctx.db.patch(row._id, same ? { upstashKeyEnc: valueEnc } : { upstashKeyEnc: valueEnc, workstationSnapshotId: undefined, workstationStatus: undefined, workstationError: undefined, workstationBuildStartedAt: undefined });
  },
});

export const setCliSecret = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    const userId = await requireUserId(ctx);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail("invalid", "bad secret name");
    if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) fail("invalid", "secret value too large");
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
    if (!Number.isSafeInteger(installationId) || installationId <= 0) fail("invalid", "bad installation id");
    // Local dev/e2e only (BOX_PROVIDER=sim, already the "no real GitHub App" switch in bridge.ts): code "sim" skips GitHub.
    const simulated = process.env.BOX_PROVIDER === "sim" && code === "sim";
    let githubLogin: string | undefined;
    if (!simulated) {
      const clientId = process.env.GITHUB_APP_CLIENT_ID;
      const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
      if (!clientId || !clientSecret) fail("not_configured", "GitHub App OAuth is not configured");
      let verified: { login: string } | null = null;
      try {
        verified = await verifyInstallationOwnership(code, installationId, { clientId, clientSecret });
      } catch (e) {
        console.error("github install verification failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
        fail("github_error", "could not verify the GitHub installation");
      }
      if (!verified) fail("forbidden", "installation is not authorized for this GitHub account");
      githubLogin = verified.login;
    }
    await ctx.runMutation(internal.settings.storeGithubInstallation, { userId, installationId, githubLogin });
  },
});

export const storeGithubInstallation = internalMutation({
  args: { userId: v.string(), installationId: v.number(), githubLogin: v.optional(v.string()) },
  handler: async (ctx, { userId, installationId, githubLogin }) => {
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { githubInstallationId: installationId, githubLogin });
  },
});

export const setSleepMinutes = mutation({
  args: { minutes: v.number() },
  handler: async (ctx, { minutes }) => {
    const userId = await requireUserId(ctx);
    // NaN slips through Math.min/max, then `runAfter(NaN)` throws inside bridge.push and wedges the dork in `working`.
    if (!Number.isFinite(minutes)) fail("invalid", "minutes must be a finite number");
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { sleepMinutes: Math.min(Math.max(minutes, 0.05), 24 * 60) });
  },
});

export const MAX_ALLOWLIST_LOGIN_CHARS = 100; // GitHub logins are at most 39 chars (bots add "[bot]")

/** Which PR comment authors may wake the user's dorks (docs/autonomy.md). Absent = everyone. */
export const setCommentPolicy = mutation({
  args: { policy: v.any() },
  handler: async (ctx, { policy }) => {
    const userId = await requireUserId(ctx);
    const parsed = commentPolicySchema.safeParse(policy);
    if (!parsed.success) fail("invalid", "bad comment policy");
    if (parsed.data.mode === "allowlist" && parsed.data.logins.some((l) => !l.trim() || l.length > MAX_ALLOWLIST_LOGIN_CHARS)) fail("invalid", "bad GitHub login in the allowlist");
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, { commentPolicy: parsed.data });
  },
});
