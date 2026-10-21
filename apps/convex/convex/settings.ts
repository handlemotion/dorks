import { commentPolicy as commentPolicySchema, DEFAULT_COMMENT_POLICY, DEFAULT_ENGINE, OPENCODE_MODEL_RE } from "@dorks/shared";
import { v } from "convex/values";
import { aad, encrypt, keyringFromEnv } from "../core/crypto";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./auth";
import { fail } from "./lib/dispatch";
import { engine } from "./validators";
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
    const secrets = await ctx.db.query("userSecrets").withIndex("by_user_name", (q) => q.eq("userId", userId)).collect();
    return {
      claudeToken: !!s?.claudeTokenEnc, github: !!s?.githubInstallationId, sleepMinutes: s?.sleepMinutes ?? 5, commentPolicy: s?.commentPolicy ?? DEFAULT_COMMENT_POLICY,
      defaultEngine: s?.defaultEngine ?? DEFAULT_ENGINE, opencodeModel: s?.opencodeModel ?? null,
      // OpenCode reads provider keys from the environment (CLI secrets); this is only a hint for the UI, not a requirement.
      providerKey: secrets.some((r) => PROVIDER_KEY_RE.test(r.name)),
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

/** CLI secret names OpenCode can authenticate a provider with (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ...). */
export const PROVIDER_KEY_RE = /_API_KEY$/;

/** The engine new dorks run by default, and the model OpenCode dorks use (null or "" clears it: OpenCode picks). */
export const setEngineDefaults = mutation({
  args: { defaultEngine: v.optional(engine), opencodeModel: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { defaultEngine, opencodeModel }) => {
    const userId = await requireUserId(ctx);
    const model = typeof opencodeModel === "string" ? opencodeModel.trim() : opencodeModel;
    if (model && !OPENCODE_MODEL_RE.test(model)) fail("invalid", "model must be <provider>/<model>, e.g. anthropic/claude-sonnet-4-5");
    const row = await settingsRow(ctx, userId);
    await ctx.db.patch(row._id, {
      ...(defaultEngine !== undefined ? { defaultEngine } : {}),
      ...(model !== undefined ? { opencodeModel: model || undefined } : {}),
    });
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
