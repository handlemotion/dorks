import { aad, decrypt, keyringFromEnv } from "../lib/crypto";
import { createInstallationToken } from "../lib/github";
import { SimBox, unconfiguredBox, type BoxProvider } from "../lib/box";

export interface RuntimeConfig {
  claudeToken: string;
  cliSecrets: Record<string, string>;
  snapshotId: string;
  sleepMinutes: number;
}

export interface SummaryPatch {
  status?: string;
  lastPreview?: string;
  lastActivityAt?: number;
  boxId?: string | null;
  claudeSessionId?: string;
  prUrl?: string;
  archivedAt?: number | null;
}

export interface Deps {
  box: BoxProvider;
  runtime: {
    /** Decrypts and assembles everything injected on wake. Throws OnboardingError if the user is not set up. */
    resolve(userId: string): Promise<RuntimeConfig>;
    githubToken(userId: string): Promise<string>;
  };
  summary: { update(dorkId: string, patch: SummaryPatch): Promise<void> };
}

/** Errors whose message is safe to show to the user. */
export class OnboardingError extends Error {}

export async function missingOnboarding(env: Pick<Env, "DB">, userId: string): Promise<string[]> {
  const s = await env.DB.prepare("SELECT claude_token_enc, github_installation_id FROM user_settings WHERE user_id = ?").bind(userId).first<{ claude_token_enc: string | null; github_installation_id: number | null }>();
  const missing: string[] = [];
  if (!s?.claude_token_enc) missing.push("claude_token");
  if (!s?.github_installation_id) missing.push("github");
  return missing;
}

const COLUMN: Record<keyof SummaryPatch, string> = {
  status: "status", lastPreview: "last_preview", lastActivityAt: "last_activity_at", boxId: "box_id",
  claudeSessionId: "claude_session_id", prUrl: "pr_url", archivedAt: "archived_at",
};

// Module-level so dev "boxes" survive Durable Object eviction, like a real provider's boxes would.
let devSingleton: SimBox | undefined;
function devBox() {
  if (!devSingleton) {
    devSingleton = new SimBox();
    devSingleton.announce = true;
    devSingleton.lenient = true;
  }
  return devSingleton;
}

export function createDeps(env: Env): Deps {
  const ring = keyringFromEnv(env);
  const settings = (userId: string) =>
    env.DB.prepare("SELECT claude_token_enc, github_installation_id, workstation_snapshot_id, sleep_minutes FROM user_settings WHERE user_id = ?")
      .bind(userId).first<{ claude_token_enc: string | null; github_installation_id: number | null; workstation_snapshot_id: string | null; sleep_minutes: number }>();

  return {
    box: env.BOX_PROVIDER === "sim" ? devBox() : unconfiguredBox,
    runtime: {
      async resolve(userId) {
        const s = await settings(userId);
        if (!s?.claude_token_enc) throw new OnboardingError("Claude token not set");
        const snapshotId = s.workstation_snapshot_id || env.BASE_SNAPSHOT_ID;
        if (!snapshotId) throw new OnboardingError("No base snapshot configured");
        const rows = await env.DB.prepare("SELECT name, value_enc FROM user_secrets WHERE user_id = ?").bind(userId).all<{ name: string; value_enc: string }>();
        const cliSecrets: Record<string, string> = {};
        for (const r of rows.results) cliSecrets[r.name] = await decrypt(ring, r.value_enc, aad.secret(userId, r.name));
        return { claudeToken: await decrypt(ring, s.claude_token_enc, aad.claudeToken(userId)), cliSecrets, snapshotId, sleepMinutes: s.sleep_minutes };
      },
      async githubToken(userId) {
        const s = await settings(userId);
        if (!s?.github_installation_id) throw new OnboardingError("GitHub App not installed");
        if (env.BOX_PROVIDER === "sim") return "sim-github-token"; // local dev: no real GitHub App
        return (await createInstallationToken(env, s.github_installation_id)).token;
      },
    },
    summary: {
      async update(dorkId, patch) {
        const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof SummaryPatch, unknown][];
        if (!entries.length) return;
        const sets = entries.map(([k]) => `${COLUMN[k]} = ?`).join(", ");
        await env.DB.prepare(`UPDATE dorks SET ${sets} WHERE id = ?`).bind(...entries.map(([, v]) => v), dorkId).run();
      },
    },
  };
}
