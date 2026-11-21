import { commentPolicy as commentPolicySchema, DEFAULT_COMMENT_POLICY, type CommentPolicy } from "@dorks/shared";
import { knownModelChoices } from "./models";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { json, update } from "../db";
import type { GhLogin } from "../lib/ghCli";

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
  /** The owner chose to let Dorks act as their GitHub CLI login (the token itself is never stored: see githubLogin below). */
  githubConnected: boolean;
  githubLogin?: string;
  commentPolicy?: CommentPolicy;
  /** New Claude sessions start in Code Mode. */
  claudeCodeMode: boolean;
  /** Every session may use the owner's computer without asking (docs/local-access.md). */
  localAlwaysAllow: boolean;
}

const n = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function readSettings(app: App): Settings {
  const r = app.db.get("SELECT * FROM settings WHERE id = 1")!;
  return {
    sleepMinutes: r.sleep_minutes as number,
    claudeTokenEnc: n(r.claude_token_enc as string | null),
    boatKeyEnc: n(r.boat_key_enc as string | null),
    boatOrg: n(r.boat_org as string | null),
    boatEnvironment: n(r.boat_environment as string | null),
    baseSnapshotId: n(r.base_snapshot_id as string | null),
    githubConnected: !!r.github_connected,
    githubLogin: n(r.github_login as string | null),
    commentPolicy: json(r.comment_policy),
    claudeCodeMode: !!r.claude_code_mode,
    localAlwaysAllow: !!r.local_always_allow,
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
    github: { configured: s.githubConnected, login: s.githubLogin ?? null },
    sleepMinutes: s.sleepMinutes,
    commentPolicy: s.commentPolicy ?? DEFAULT_COMMENT_POLICY,
    claudeCodeMode: s.claudeCodeMode,
    localAlwaysAllow: s.localAlwaysAllow,
    boxProvider: app.cfg.boxProvider,
    claudeModels: knownModelChoices(app),
    defaultBuildId: app.db.get<{ default_build_id: string | null }>("SELECT default_build_id FROM settings WHERE id = 1")?.default_build_id ?? null,
  };
}

export const secretNames = (app: App): string[] => app.db.all<{ name: string }>("SELECT name FROM secrets ORDER BY name").map((r) => r.name);

export interface SettingsPatch {
  boatKey?: string;
  boatOrg?: string;
  claudeToken?: string;
  /** true: act as the GitHub CLI's login (checked with GitHub first); false: disconnect. */
  githubConnected?: boolean;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  sleepMinutes?: number;
  commentPolicy?: unknown;
  /** New Claude sessions start in Code Mode; existing ones keep what they started with. */
  claudeCodeMode?: unknown;
  /** Sessions use the owner's computer without asking; off, each session asks once again (those already allowed stay allowed). */
  localAlwaysAllow?: unknown;
}

const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string") fail("invalid", `${what} must be a string`);
  const t = v.trim();
  if (t.length > max) fail("invalid", `${what} is too long`);
  return t;
};

/** Looks up whose token this is, so the poller can ignore the agent's own activity. Null when GitHub cannot be reached. */
async function githubLoginOf(app: App, token: string, source: "env" | "gh"): Promise<string | null> {
  if (app.cfg.boxProvider === "sim") return null; // local simulation: no GitHub
  let res: Response;
  try {
    res = await app.fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dorks" } });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403)
    fail("invalid", source === "env" ? "GitHub rejected the GH_TOKEN this server was started with." : "GitHub rejected the GitHub CLI’s login. Run `gh auth login` in a terminal, then connect again.");
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as { login?: unknown } | null;
  return typeof j?.login === "string" ? j.login : null;
}

/** Plain words for a GitHub CLI that cannot give a login. */
export const GH_PROBLEM: Record<"gh_missing" | "gh_logged_out", string> = {
  gh_missing: "The GitHub CLI isn’t installed. Install it (`brew install gh`), run `gh auth login`, then connect again.",
  gh_logged_out: "The GitHub CLI isn’t signed in. Run `gh auth login` in a terminal, then connect again.",
};

/** Connecting checks the GitHub CLI's login with GitHub before it is saved. The local simulation connects without one. */
async function githubConnection(app: App, connect: unknown): Promise<Record<string, unknown>> {
  if (typeof connect !== "boolean") fail("invalid", "githubConnected must be true or false");
  forgetGhLogin(app);
  if (!connect) return { githubConnected: 0, githubLogin: null };
  const read = await app.ghLogin();
  if ("problem" in read) {
    if (app.cfg.boxProvider === "sim") return { githubConnected: 1, githubLogin: null };
    fail("invalid", GH_PROBLEM[read.problem]);
  }
  const githubLogin = await githubLoginOf(app, read.token, read.source);
  confirmed.set(app, read.token); // checked just now: its login is the one saved below
  return { githubConnected: 1, githubLogin };
}

const boatEnvironmentOf = (v: unknown) => {
  const t = text(v, "Boat environment", 63);
  if (t && !/^[a-z][a-z0-9_-]{0,62}$/.test(t)) fail("invalid", "enter a Boat environment name");
  return t || null;
};

const sleepMinutesOf = (v: unknown) => {
  // NaN slips through Math.min/max and would corrupt every timer computed from it.
  if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid", "minutes must be a finite number");
  return Math.min(Math.max(v, 0.05), 24 * 60);
};

const commentPolicyOf = (v: unknown) => {
  const parsed = commentPolicySchema.safeParse(v);
  if (!parsed.success) fail("invalid", "bad comment policy");
  if (parsed.data.mode === "allowlist" && parsed.data.logins.some((l) => !l.trim() || l.length > MAX_ALLOWLIST_LOGIN_CHARS)) fail("invalid", "bad GitHub login in the allowlist");
  return parsed.data;
};

/** Applies any subset of settings. An empty string clears a token or name. Encryption and GitHub lookups happen before the write transaction. */
export async function updateSettings(app: App, patch: SettingsPatch): Promise<void> {
  const row: Record<string, unknown> = {};
  /** The trimmed secret encrypted for the settings row, or null to clear it. */
  const sealed = async (t: string, a: string) => (t ? (await encrypt(app.ring, t, a)).value : null);

  if (patch.boatKey !== undefined) row.boatKeyEnc = await sealed(text(patch.boatKey, "Boat API key", 512), aad.boatKey(OWNER));
  if (patch.boatOrg !== undefined) row.boatOrg = text(patch.boatOrg, "Boat organization", 128) || null;
  if (patch.claudeToken !== undefined) row.claudeTokenEnc = await sealed(text(patch.claudeToken, "token", MAX_TOKEN_CHARS), aad.claudeToken(OWNER));
  if (patch.githubConnected !== undefined) Object.assign(row, await githubConnection(app, patch.githubConnected));
  if (patch.boatEnvironment !== undefined) row.boatEnvironment = boatEnvironmentOf(patch.boatEnvironment);
  if (patch.baseSnapshotId !== undefined) row.baseSnapshotId = text(patch.baseSnapshotId, "snapshot", 200) || null;
  if (patch.sleepMinutes !== undefined) row.sleepMinutes = sleepMinutesOf(patch.sleepMinutes);
  if (patch.commentPolicy !== undefined) row.commentPolicy = commentPolicyOf(patch.commentPolicy);
  if (patch.claudeCodeMode !== undefined) {
    if (typeof patch.claudeCodeMode !== "boolean") fail("invalid", "claudeCodeMode must be true or false");
    row.claudeCodeMode = patch.claudeCodeMode;
  }
  if (patch.localAlwaysAllow !== undefined) {
    if (typeof patch.localAlwaysAllow !== "boolean") fail("invalid", "localAlwaysAllow must be true or false");
    row.localAlwaysAllow = patch.localAlwaysAllow;
  }
  if (!Object.keys(row).length) return;
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, row);
    touch(app, { t: "settings" });
  });
  // Turning Always allow on also answers the requests already waiting (local.ts imports this module, hence the dynamic import).
  if (row.localAlwaysAllow === true) (await import("./local")).startWaitingLocal(app);
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
// ---------------------------------------------------------------- the GitHub CLI's login (never stored; cached in memory for a minute)
const GH_TTL_MS = 60_000;
const ghCache = new WeakMap<App, { at: number; login: GhLogin }>();
const confirmed = new WeakMap<App, string>();

/** Forget the cached login, so the next read asks `gh` again (connecting, disconnecting, an explicit refresh). */
export function forgetGhLogin(app: App): void {
  ghCache.delete(app);
}

/**
 * The GitHub CLI's login when the owner connected GitHub, null when they did not. A token this process has not confirmed (after a
 * restart, `gh auth switch` or a new login) clears the remembered login, so the poller learns whose it is again.
 */
export async function githubLogin(app: App): Promise<GhLogin | null> {
  if (!readSettings(app).githubConnected) return null;
  const cached = ghCache.get(app);
  if (cached && app.now() - cached.at < GH_TTL_MS) return cached.login;
  const login = await app.ghLogin();
  // The token this process last confirmed. On the first read after a restart it is unknown, and gh may have switched accounts
  // meanwhile, so the remembered login is dropped then too: the poller and the repository list learn it again.
  if ("token" in login && confirmed.get(app) !== login.token) {
    update(app.db, "settings", { id: 1 }, { githubLogin: null });
    confirmed.set(app, login.token);
  }
  // Only a working login is cached: after `gh auth login` the next read picks it up.
  if ("token" in login) ghCache.set(app, { at: app.now(), login });
  else ghCache.delete(app);
  return login;
}

/** The token every GitHub call and every sandbox uses: the GitHub CLI's, when connected. */
export async function githubToken(app: App): Promise<string | undefined> {
  const login = await githubLogin(app);
  return login && "token" in login ? login.token : undefined;
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
