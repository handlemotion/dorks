import { commentPolicy as commentPolicySchema, DEFAULT_COMMENT_POLICY, type CommentPolicy } from "@dorks/shared";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { json, update } from "../db";

export const MAX_TOKEN_CHARS = 4 * 1024;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_ALLOWLIST_LOGIN_CHARS = 100; // GitHub logins are at most 39 chars (bots add "[bot]")
export const DEFAULT_SLEEP_MINUTES = 5;

export interface Settings {
  sleepMinutes: number;
  claudeTokenEnc?: string;
  boatKeyEnc?: string;
  boatOrg?: string;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  githubTokenEnc?: string;
  githubLogin?: string;
  commentPolicy?: CommentPolicy;
}

const n = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function readSettings(app: App): Settings {
  const r = app.db.get("SELECT * FROM settings WHERE id = 1")!;
  return {
    sleepMinutes: r.sleep_minutes as number, claudeTokenEnc: n(r.claude_token_enc as string | null), boatKeyEnc: n(r.boat_key_enc as string | null),
    boatOrg: n(r.boat_org as string | null), boatEnvironment: n(r.boat_environment as string | null), baseSnapshotId: n(r.base_snapshot_id as string | null),
    githubTokenEnc: n(r.github_token_enc as string | null), githubLogin: n(r.github_login as string | null), commentPolicy: json(r.comment_policy),
  };
}

/** Booleans and plain values only: ciphertext and tokens never leave the server. */
export function settingsView(app: App) {
  const s = readSettings(app);
  return {
    claudeToken: !!s.claudeTokenEnc,
    boatKey: !!s.boatKeyEnc,
    boatOrg: s.boatOrg ?? null,
    boatEnvironment: s.boatEnvironment ?? null,
    baseSnapshotId: s.baseSnapshotId ?? app.cfg.baseSnapshotId ?? null,
    github: { configured: !!s.githubTokenEnc, login: s.githubLogin ?? null },
    sleepMinutes: s.sleepMinutes,
    commentPolicy: s.commentPolicy ?? DEFAULT_COMMENT_POLICY,
    publicUrlConfigured: !!app.cfg.publicUrl,
    boxProvider: app.cfg.boxProvider,
  };
}

export const secretNames = (app: App): string[] => app.db.all<{ name: string }>("SELECT name FROM secrets ORDER BY name").map((r) => r.name);

export interface SettingsPatch {
  boatKey?: string;
  boatOrg?: string;
  claudeToken?: string;
  githubToken?: string;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  sleepMinutes?: number;
  commentPolicy?: unknown;
}

const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string") fail("invalid", `${what} must be a string`);
  const t = v.trim();
  if (t.length > max) fail("invalid", `${what} is too long`);
  return t;
};

/** Looks up whose token this is, so the poller can ignore the agent's own activity. Null when GitHub cannot be reached. */
async function githubLoginOf(app: App, token: string): Promise<string | null> {
  if (app.cfg.boxProvider === "sim") return null; // local simulation: no GitHub
  let res: Response;
  try {
    res = await app.fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dorks" } });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) fail("invalid", "GitHub rejected that token");
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as { login?: unknown } | null;
  return typeof j?.login === "string" ? j.login : null;
}

/** Applies any subset of settings. An empty string clears a token or name. Encryption and GitHub lookups happen before the write transaction. */
export async function updateSettings(app: App, patch: SettingsPatch): Promise<void> {
  const row: Record<string, unknown> = {};
  const encOf = async (v: string, a: string) => (await encrypt(app.ring, v, a)).value;

  if (patch.boatKey !== undefined) {
    const t = text(patch.boatKey, "Boat API key", 512);
    row.boatKeyEnc = t ? await encOf(t, aad.boatKey(OWNER)) : null;
  }
  if (patch.boatOrg !== undefined) row.boatOrg = text(patch.boatOrg, "Boat organization", 128) || null;
  if (patch.claudeToken !== undefined) {
    const t = text(patch.claudeToken, "token", MAX_TOKEN_CHARS);
    row.claudeTokenEnc = t ? await encOf(t, aad.claudeToken(OWNER)) : null;
  }
  if (patch.githubToken !== undefined) {
    const t = text(patch.githubToken, "GitHub token", MAX_TOKEN_CHARS);
    row.githubTokenEnc = t ? await encOf(t, aad.githubToken(OWNER)) : null;
    row.githubLogin = t ? await githubLoginOf(app, t) : null;
  }
  if (patch.boatEnvironment !== undefined) {
    const t = text(patch.boatEnvironment, "Boat environment", 63);
    if (t && !/^[a-z][a-z0-9_-]{0,62}$/.test(t)) fail("invalid", "enter a Boat environment name");
    row.boatEnvironment = t || null;
  }
  if (patch.baseSnapshotId !== undefined) row.baseSnapshotId = text(patch.baseSnapshotId, "snapshot", 200) || null;
  if (patch.sleepMinutes !== undefined) {
    // NaN slips through Math.min/max and would corrupt every timer computed from it.
    if (typeof patch.sleepMinutes !== "number" || !Number.isFinite(patch.sleepMinutes)) fail("invalid", "minutes must be a finite number");
    row.sleepMinutes = Math.min(Math.max(patch.sleepMinutes, 0.05), 24 * 60);
  }
  if (patch.commentPolicy !== undefined) {
    const parsed = commentPolicySchema.safeParse(patch.commentPolicy);
    if (!parsed.success) fail("invalid", "bad comment policy");
    if (parsed.data.mode === "allowlist" && parsed.data.logins.some((l) => !l.trim() || l.length > MAX_ALLOWLIST_LOGIN_CHARS)) fail("invalid", "bad GitHub login in the allowlist");
    row.commentPolicy = parsed.data;
  }
  if (!Object.keys(row).length) return;
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, row);
    touch(app, { t: "settings" });
  });
}

export async function setSecret(app: App, name: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail("invalid", "bad secret name");
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_SECRET_BYTES) fail("invalid", "secret value too large");
  const valueEnc = (await encrypt(app.ring, value, aad.secret(OWNER, name))).value;
  app.db.tx(() => {
    app.db.run("INSERT INTO secrets (name, value_enc) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value_enc = excluded.value_enc", name, valueEnc);
    touch(app, { t: "settings" });
  });
}

export function deleteSecret(app: App, name: string): void {
  app.db.tx(() => {
    app.db.run("DELETE FROM secrets WHERE name = ?", name);
    touch(app, { t: "settings" });
  });
}

// ---------------------------------------------------------------- reading secrets (decryption is async: never inside a transaction)
export async function boatKey(app: App): Promise<string | undefined> {
  const s = readSettings(app);
  return s.boatKeyEnc ? decrypt(app.ring, s.boatKeyEnc, aad.boatKey(OWNER)) : undefined;
}
export async function githubToken(app: App): Promise<string | undefined> {
  const s = readSettings(app);
  return s.githubTokenEnc ? decrypt(app.ring, s.githubTokenEnc, aad.githubToken(OWNER)) : undefined;
}
export async function claudeToken(app: App): Promise<string | undefined> {
  const s = readSettings(app);
  return s.claudeTokenEnc ? decrypt(app.ring, s.claudeTokenEnc, aad.claudeToken(OWNER)) : undefined;
}
export async function cliSecrets(app: App): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of app.db.all<{ name: string; value_enc: string }>("SELECT name, value_enc FROM secrets ORDER BY name")) out[r.name] = await decrypt(app.ring, r.value_enc, aad.secret(OWNER, r.name));
  return out;
}

