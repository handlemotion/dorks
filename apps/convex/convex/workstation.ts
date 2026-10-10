import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { requireUserId } from "./auth";
import { fail } from "./lib/dispatch";
import { userUpstashKey } from "./lib/box";
import { buildBaseSnapshot, deleteSnapshot } from "./lib/workstationBuild";

// The workstation image: the base snapshot every dork box of a user is restored from. With bring-your-own-Upstash it has to exist in the
// USER's account, so each user builds their own once (and again when the bridge or tool versions change), with their own key.
// The dorks-bridge bundle it is built from is a platform file, published on each deploy (`pnpm bridge:publish`).

const BUILD_STALE_MS = 15 * 60_000; // a build that has not finished in this long is presumed dead and may be restarted

const sha256Hex = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// --- the bridge bundle (admin: run through `convex run`, see scripts/publish-bridge.mjs) -----------------------------------------------

export const bundleUploadUrl = internalMutation({ args: {}, handler: async (ctx) => ctx.storage.generateUploadUrl() });

export const registerBundle = internalMutation({
  args: { storageId: v.id("_storage"), sha256: v.string(), bytes: v.number() },
  handler: async (ctx, { storageId, sha256, bytes }) => {
    const old = await ctx.db.query("platformFiles").withIndex("by_key", (q) => q.eq("key", "bridge")).unique();
    if (old) {
      await ctx.db.delete(old._id);
      if (old.storageId !== storageId) await ctx.storage.delete(old.storageId);
    }
    await ctx.db.insert("platformFiles", { key: "bridge", storageId, sha256, bytes, updatedAt: Date.now() });
  },
});

export const bundleInfo = internalQuery({
  args: {},
  handler: async (ctx) => {
    const f = await ctx.db.query("platformFiles").withIndex("by_key", (q) => q.eq("key", "bridge")).unique();
    return f ? { storageId: f.storageId, sha256: f.sha256, bytes: f.bytes } : null;
  },
});

// --- building the user's image ------------------------------------------------------------------------------------------------------

export const beginBuild = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!s?.upstashKeyEnc) return { ok: false as const, reason: "no_key" as const };
    if (s.workstationStatus === "building" && Date.now() - (s.workstationBuildStartedAt ?? 0) < BUILD_STALE_MS) return { ok: false as const, reason: "already_building" as const };
    await ctx.db.patch(s._id, { workstationStatus: "building", workstationBuildStartedAt: Date.now(), workstationError: undefined });
    return { ok: true as const, previousSnapshotId: s.workstationSnapshotId ?? null };
  },
});

export const finishBuild = internalMutation({
  args: { userId: v.string(), snapshotId: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { userId, snapshotId, error }) => {
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!s) return;
    if (snapshotId) await ctx.db.patch(s._id, { workstationSnapshotId: snapshotId, workstationStatus: "ready", workstationError: undefined, workstationBuildStartedAt: undefined });
    else await ctx.db.patch(s._id, { workstationStatus: "failed", workstationError: error ?? "build failed", workstationBuildStartedAt: undefined });
  },
});

/**
 * Builds the user's workstation image in their own Upstash account (a few minutes; they pay Upstash for the build box's CPU and the
 * snapshot's storage). Returns when it is ready or has failed; `settings.onboarding` shows the status meanwhile.
 */
export const provision = action({
  args: {},
  handler: async (ctx): Promise<{ snapshotId: string }> => {
    const userId = await requireUserId(ctx);
    if (process.env.BOX_PROVIDER !== "upstash") fail("not_configured", "this deployment does not use Upstash boxes");
    const begun = await ctx.runMutation(internal.workstation.beginBuild, { userId });
    if (!begun.ok) fail(begun.reason === "no_key" ? "onboarding_incomplete" : "conflict", begun.reason === "no_key" ? "add your Upstash API key first" : "your sandbox image is already being built");
    const apiKey = await userUpstashKey(ctx, userId);
    try {
      if (!apiKey) throw new Error("no key");
      const info = await ctx.runQuery(internal.workstation.bundleInfo, {});
      if (!info) throw new Error("the bridge bundle has not been published to this deployment (pnpm bridge:publish)");
      const blob = await ctx.storage.get(info.storageId);
      if (!blob) throw new Error("the bridge bundle is missing from storage");
      const bytes = await blob.arrayBuffer(); // a storage Blob is a one-shot stream: read it once, and send a fresh Blob
      if ((await sha256Hex(bytes)) !== info.sha256) throw new Error("the bridge bundle does not match its recorded checksum");
      const baseUrl = process.env.UPSTASH_BOX_BASE_URL || undefined;
      const snapshotId = await buildBaseSnapshot({
        apiKey, baseUrl, bundle: new Blob([bytes]), snapshotName: `dorks-base-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
        log: (m) => console.log("[workstation]", m),
      });
      await ctx.runMutation(internal.workstation.finishBuild, { userId, snapshotId });
      // Boxes already made keep their filesystem, so the superseded image is safe to drop (storage is billed to the user).
      if (begun.previousSnapshotId) await deleteSnapshot({ apiKey, baseUrl, snapshotId: begun.previousSnapshotId }).catch(() => {});
      return { snapshotId };
    } catch (e) {
      console.error("workstation provision failed", e instanceof Error ? e.message.slice(0, 300) : "unknown");
      await ctx.runMutation(internal.workstation.finishBuild, { userId, error: e instanceof Error ? e.message.slice(0, 200) : "build failed" });
      fail("failed", "could not build your sandbox image; see the message in settings and try again");
    }
  },
});
