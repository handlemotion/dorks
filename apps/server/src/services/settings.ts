import { commentPolicy as commentPolicySchema, DEFAULT_COMMENT_POLICY, isDorkLocation, type CommentPolicy, type DorkLocation, type LocalAvailability } from "@dorks/shared";
import { knownAntigravityModels, knownCodexModels, knownModelChoices } from "./models";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "@dorks/core/crypto";
import { json, update } from "../db";
import type { GhLogin } from "../lib/ghCli";
import { organizationApi, SENTRY_URL, SentryError, sentryOrigin, type SentryClient } from "../lib/sentry";
import { antigravitySignInView, cancelAntigravitySignIn } from "./antigravitySignIn";
import { boatSignInView, invalidateBoatSignIn } from "./boatSignIn";
import { codexAccountView, codexSignInView } from "./codexSignIn";

export const MAX_TOKEN_CHARS = 4 * 1024;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_ALLOWLIST_LOGIN_CHARS = 100; // GitHub logins are at most 39 chars (bots add "[bot]")
export const DEFAULT_SLEEP_MINUTES = 5;

export interface Settings {
  sleepMinutes: number;
  claudeTokenEnc?: string;
  /** agy's token file (JSON), from the Antigravity sign-in (services/antigravitySignIn.ts). */
  antigravityTokenEnc?: string;
  boatKeyEnc?: string;
  /** The id of the key Dorks made itself with the Boat CLI (services/boatSignIn.ts), so changing the key revokes it. */
  boatKeyId?: string;
  /** Make a Boat key with the Boat CLI when none is saved. Off once the owner clears the key, on again when they connect. */
  boatAuto: boolean;
  boatOrg?: string;
  boatEnvironment?: string;
  baseSnapshotId?: string;
  /** The owner chose to let Dorks act as their GitHub CLI login (the token itself is never stored: see githubLogin below). */
  githubConnected: boolean;
  /** Connect GitHub by itself when the GitHub CLI is signed in. Off once the owner disconnects, on again when they connect. */
  githubAuto: boolean;
  githubLogin?: string;
  commentPolicy?: CommentPolicy;
  /** New Claude sessions start in Code Mode. */
  claudeCodeMode: boolean;
  /** Every session may use the owner's computer without asking (docs/local-access.md). */
  localAlwaysAllow: boolean;
  /** Where the new-session composer starts (docs/local-dorks.md): its Cloud / Local switch's remembered choice. */
  defaultLocation: DorkLocation;
  /** Sentry, for automations' Sentry triggers (docs/automations.md, "Sentry"): the owner's token, its organization, a self-hosted URL. */
  sentryTokenEnc?: string;
  sentryOrg?: string;
  sentryUrl?: string;
  /** The API origin the organization lives on (its region), learned when the token was checked. */
  sentryApi?: string;
}

const n = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function readSettings(app: App): Settings {
  const r = app.db.get("SELECT * FROM settings WHERE id = 1")!;
  return {
    sleepMinutes: r.sleep_minutes as number,
    claudeTokenEnc: n(r.claude_token_enc as string | null),
    antigravityTokenEnc: n(r.antigravity_token_enc as string | null),
    boatKeyEnc: n(r.boat_key_enc as string | null),
    boatKeyId: n(r.boat_key_id as string | null),
    boatAuto: !!r.boat_auto,
    boatOrg: n(r.boat_org as string | null),
    boatEnvironment: n(r.boat_environment as string | null),
    baseSnapshotId: n(r.base_snapshot_id as string | null),
    githubConnected: !!r.github_connected,
    githubAuto: !!r.github_auto,
    githubLogin: n(r.github_login as string | null),
    commentPolicy: json(r.comment_policy),
    claudeCodeMode: !!r.claude_code_mode,
    localAlwaysAllow: !!r.local_always_allow,
    defaultLocation: r.default_location === "local" ? "local" : "cloud",
    sentryTokenEnc: n(r.sentry_token_enc as string | null),
    sentryOrg: n(r.sentry_org as string | null),
    sentryUrl: n(r.sentry_url as string | null),
    sentryApi: n(r.sentry_api as string | null),
  };
}

/** Why GitHub did not connect by itself, while it is not connected. */
const githubProblemOf = (app: App, s: Settings) => {
  const problem = s.githubConnected || !s.githubAuto ? undefined : githubProblem.get(app);
  return problem ? { problem } : {};
};

/**
 * Booleans and plain values only: ciphertext and tokens never leave the server. `local` is whether the asking client may start local
 * dorks (services/localDorks.ts); without one, as for a relayed client, it may not.
 */
export function settingsView(app: App, local: LocalAvailability = { available: false }) {
  const s = readSettings(app);
  return {
    claudeToken: !!s.claudeTokenEnc,
    antigravityToken: !!s.antigravityTokenEnc,
    // Antigravity can start: the Google sign-in, or a shared secret for it (agy's token file, or a Gemini API key).
    antigravityReady: !!s.antigravityTokenEnc || secretNames(app).some((n) => ANTIGRAVITY_SECRETS.includes(n)),
    antigravitySignIn: antigravitySignInView(app),
    antigravityModels: knownAntigravityModels(app),
    codexModels: knownCodexModels(app),
    // Dorks' own ChatGPT sign-in for Codex (services/codexSignIn.ts): the account, or the sign-in to offer.
    codexAccount: codexAccountView(app),
    codexSignIn: codexSignInView(app),
    boatKey: !!s.boatKeyEnc,
    boatOrg: s.boatOrg ?? null,
    boatEnvironment: s.boatEnvironment ?? null,
    baseSnapshotId: s.baseSnapshotId ?? app.cfg.baseSnapshotId ?? null,
    github: { configured: s.githubConnected, login: s.githubLogin ?? null, ...githubProblemOf(app, s) },
    boatSignIn: boatSignInView(app),
    sleepMinutes: s.sleepMinutes,
    commentPolicy: s.commentPolicy ?? DEFAULT_COMMENT_POLICY,
    claudeCodeMode: s.claudeCodeMode,
    localAlwaysAllow: s.localAlwaysAllow,
    local,
    // A client that cannot start local dorks starts every session in the cloud, whatever the owner picked on their computer.
    defaultLocation: local.available ? s.defaultLocation : "cloud",
    sentry: { connected: !!(s.sentryTokenEnc && s.sentryOrg), org: s.sentryOrg ?? null, url: s.sentryUrl ?? null },
    boxProvider: app.cfg.boxProvider,
    claudeModels: knownModelChoices(app),
    defaultBuildId: app.db.get<{ default_build_id: string | null }>("SELECT default_build_id FROM settings WHERE id = 1")?.default_build_id ?? null,
  };
}

/** Shared secrets that sign Antigravity in without the Google sign-in (infra/bridge/src/antigravity.ts). */
export const ANTIGRAVITY_SECRETS = ["ANTIGRAVITY_OAUTH_TOKEN", "GEMINI_API_KEY"];

export const secretNames = (app: App): string[] => app.db.all<{ name: string }>("SELECT name FROM secrets ORDER BY name").map((r) => r.name);

export interface SettingsPatch {
  boatKey?: string;
  boatOrg?: string;
  claudeToken?: string;
  /** agy's token file as the Antigravity sign-in saved it; "" signs Antigravity out. */
  antigravityToken?: string;
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
  /** Where new sessions start by default: `cloud` or `local` (docs/local-dorks.md). */
  defaultLocation?: unknown;
  /** Sentry's token ("" disconnects), organization slug and, for a self-hosted Sentry, its URL ("" for sentry.io). Checked with Sentry first. */
  sentryToken?: unknown;
  sentryOrg?: unknown;
  sentryUrl?: unknown;
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
  if (!connect) return { githubConnected: 0, githubAuto: 0, githubLogin: null };
  const read = await app.ghLogin();
  if ("problem" in read) {
    if (app.cfg.boxProvider === "sim") return { githubConnected: 1, githubAuto: 1, githubLogin: null };
    fail("invalid", GH_PROBLEM[read.problem]);
  }
  const githubLogin = await githubLoginOf(app, read.token, read.source);
  confirmed.set(app, read.token); // checked just now: its login is the one saved below
  return { githubConnected: 1, githubAuto: 1, githubLogin };
}

const boatEnvironmentOf = (v: unknown) => {
  const t = text(v, "Boat environment", 63);
  if (t && !/^[a-z][a-z0-9_-]{0,62}$/.test(t)) fail("invalid", "enter a Boat environment name");
  return t || null;
};

const flagOf = (v: unknown, name: string) => {
  if (typeof v !== "boolean") fail("invalid", `${name} must be true or false`);
  return v;
};

/** The owner's plain preferences a patch sets: Code Mode, Always allow, where new sessions start. */
function preferenceFields(patch: SettingsPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.claudeCodeMode !== undefined) row.claudeCodeMode = flagOf(patch.claudeCodeMode, "claudeCodeMode");
  if (patch.localAlwaysAllow !== undefined) row.localAlwaysAllow = flagOf(patch.localAlwaysAllow, "localAlwaysAllow");
  if (patch.defaultLocation !== undefined) row.defaultLocation = isDorkLocation(patch.defaultLocation) ? patch.defaultLocation : fail("invalid", "defaultLocation must be cloud or local");
  return row;
}

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
/** A Boat sign-in's result that the owner overrode while it was in flight (services/boatSignIn.ts): nothing was saved. */
export class StaleSignIn extends Error {}

/**
 * `fromSignIn`: the key comes from the Boat sign-in, which must not invalidate itself; `unless`: checked right before the write,
 * and true means nothing is written (StaleSignIn).
 */
export async function updateSettings(app: App, patch: SettingsPatch, opts: { fromSignIn?: boolean; unless?: () => boolean } = {}): Promise<void> {
  const row: Record<string, unknown> = {};
  /** The trimmed secret encrypted for the settings row, or null to clear it. */
  const sealed = async (t: string, a: string) => (t ? (await encrypt(app.ring, t, a)).value : null);

  const before = readSettings(app);
  if (patch.boatKey !== undefined) {
    const key = text(patch.boatKey, "Boat API key", 512);
    Object.assign(row, { boatKeyEnc: await sealed(key, aad.boatKey(OWNER)), boatKeyId: null, boatAuto: key ? 1 : 0 });
  }
  if (patch.boatOrg !== undefined) row.boatOrg = text(patch.boatOrg, "Boat organization", 128) || null;
  if (patch.claudeToken !== undefined) row.claudeTokenEnc = await sealed(text(patch.claudeToken, "token", MAX_TOKEN_CHARS), aad.claudeToken(OWNER));
  if (patch.antigravityToken !== undefined) row.antigravityTokenEnc = await sealed(text(patch.antigravityToken, "Antigravity sign-in", MAX_TOKEN_CHARS), aad.antigravityToken(OWNER));
  if (patch.githubConnected !== undefined) Object.assign(row, await githubConnection(app, patch.githubConnected));
  if (patch.boatEnvironment !== undefined) row.boatEnvironment = boatEnvironmentOf(patch.boatEnvironment);
  if (patch.baseSnapshotId !== undefined) row.baseSnapshotId = text(patch.baseSnapshotId, "snapshot", 200) || null;
  if (patch.sleepMinutes !== undefined) row.sleepMinutes = sleepMinutesOf(patch.sleepMinutes);
  if (patch.commentPolicy !== undefined) row.commentPolicy = commentPolicyOf(patch.commentPolicy);
  Object.assign(row, preferenceFields(patch));
  Object.assign(row, await sentryConnection(app, patch, before));
  if (!Object.keys(row).length) return;
  if (opts.unless?.()) throw new StaleSignIn("superseded");
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, row);
    touch(app, { t: "settings" });
  });
  await afterSave(app, patch, row, before.boatKeyId, !!opts.fromSignIn);
}

/** What a saved change sets off: the Boat sign-in and GitHub's automatic connect learn the owner decided, waiting requests run. */
async function afterSave(app: App, patch: SettingsPatch, row: Record<string, unknown>, previousBoatKeyId: string | undefined, fromSignIn: boolean) {
  if (patch.boatKey !== undefined) boatKeyChanged(app, previousBoatKeyId, fromSignIn);
  if (patch.antigravityToken !== undefined && !patch.antigravityToken) cancelAntigravitySignIn(app);
  if (patch.githubConnected !== undefined) githubGeneration.set(app, (githubGeneration.get(app) ?? 0) + 1);
  // Turning Always allow on also answers the requests already waiting (local.ts imports this module, hence the dynamic import).
  if (row.localAlwaysAllow === true) (await import("./local")).startWaitingLocal(app);
}

/**
 * The Boat key was saved or cleared. By the owner, it ends any sign-in in flight; either way the key Dorks made with the Boat CLI
 * before is revoked, so no unused key is left on the account.
 */
function boatKeyChanged(app: App, previousKeyId: string | undefined, fromSignIn: boolean) {
  if (!fromSignIn) invalidateBoatSignIn(app);
  if (previousKeyId) void app.boatCli.revokeKey(previousKeyId).catch(() => console.error("boat: could not revoke the previous key"));
}

// ---------------------------------------------------------------- Sentry

const SENTRY_ORG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

/** The Sentry fields a patch gives, checked, with the saved ones for those it leaves out. */
function sentryFields(patch: SettingsPatch, before: Settings) {
  const token = patch.sentryToken !== undefined ? text(patch.sentryToken, "Sentry token", MAX_TOKEN_CHARS) : undefined;
  const org = patch.sentryOrg !== undefined ? text(patch.sentryOrg, "Sentry organization", 100) : (before.sentryOrg ?? "");
  const rawUrl = patch.sentryUrl !== undefined ? text(patch.sentryUrl, "Sentry URL", 300) : (before.sentryUrl ?? "");
  const url = rawUrl ? sentryOrigin(rawUrl) : null;
  if (rawUrl && !url) fail("invalid", "Enter your Sentry's URL, like https://sentry.example.com.");
  if (org && !SENTRY_ORG.test(org)) fail("invalid", "Enter the organization's slug, as in its Sentry URL.");
  return { token, org, url };
}

/** The organization's API origin, checking the token can read it; a refusal is told in plain words. */
async function checkSentry(app: App, token: string, org: string, url: string | null): Promise<string> {
  try {
    return await organizationApi({ fetch: app.fetch, token, base: url ?? SENTRY_URL, now: () => app.now() }, org);
  } catch (e) {
    if (!(e instanceof SentryError)) throw e;
    if (e.reason === "auth") fail("invalid", "Sentry rejected that token.");
    if (e.reason === "forbidden") fail("invalid", `That token cannot read the organization ${org}. Make a personal token with org:read, project:read and event:read.`);
    if (e.reason === "not_found") fail("invalid", `Sentry has no organization ${org} that this token can see.`);
    return fail("failed", "Sentry could not be reached. Try again.");
  }
}

/**
 * The Sentry columns a patch sets (none when it touches no Sentry field). A token, organization or URL that leaves Sentry connected is
 * checked with Sentry first (the token reads the organization), which also learns the organization's region; an empty token disconnects.
 */
async function sentryConnection(app: App, patch: SettingsPatch, before: Settings): Promise<Record<string, unknown>> {
  if (patch.sentryToken === undefined && patch.sentryOrg === undefined && patch.sentryUrl === undefined) return {};
  const { token, org, url } = sentryFields(patch, before);
  const out: Record<string, unknown> = { sentryOrg: org || null, sentryUrl: url };
  if (token === "") return { ...out, sentryTokenEnc: null, sentryApi: null };
  const key = token ?? (before.sentryTokenEnc ? await decrypt(app.ring, before.sentryTokenEnc, aad.sentryToken(OWNER)) : undefined);
  if (token) out.sentryTokenEnc = (await encrypt(app.ring, token, aad.sentryToken(OWNER))).value;
  out.sentryApi = key && org ? await checkSentry(app, key, org, url) : null;
  return out;
}

/** A client for the saved Sentry connection, or null when Sentry is not connected. */
export async function sentryClient(app: App): Promise<{ client: SentryClient; org: string } | null> {
  const s = readSettings(app);
  if (!s.sentryTokenEnc || !s.sentryOrg) return null;
  const token = await decrypt(app.ring, s.sentryTokenEnc, aad.sentryToken(OWNER));
  return { client: { fetch: app.fetch, token, base: s.sentryApi ?? s.sentryUrl ?? SENTRY_URL, now: () => app.now() }, org: s.sentryOrg };
}

// ---------------------------------------------------------------- connecting GitHub by itself
const GITHUB_RECHECK_MS = 10_000;
const githubTried = new WeakMap<App, number>();
/** Bumped when the owner connects or disconnects GitHub, so an automatic attempt still in flight cannot undo it. */
const githubGeneration = new WeakMap<App, number>();
/** Why GitHub could not connect by itself (the GitHub CLI is missing or signed out), for the setup checklist. */
const githubProblem = new WeakMap<App, string>();

/**
 * Connects GitHub when the GitHub CLI is signed in and the owner has not disconnected it, so setup needs no click for it. Called on
 * start and when the settings are read (at most every 10 s, so a `gh auth login` in a terminal is picked up). Never throws.
 */
export async function autoConnectGithub(app: App): Promise<void> {
  const s = readSettings(app);
  if (s.githubConnected || !s.githubAuto) return;
  const at = githubTried.get(app);
  if (at !== undefined && app.now() - at < GITHUB_RECHECK_MS) return;
  githubTried.set(app, app.now());
  const gen = githubGeneration.get(app) ?? 0;
  try {
    const row = await githubConnection(app, true);
    githubProblem.delete(app);
    const saved = app.db.tx(() => {
      const now = readSettings(app);
      if ((githubGeneration.get(app) ?? 0) !== gen || now.githubConnected || !now.githubAuto) return false; // the owner decided meanwhile
      update(app.db, "settings", { id: 1 }, row);
      touch(app, { t: "settings" });
      return true;
    });
    if (saved) console.error("github: connected with the GitHub CLI's login");
  } catch (e) {
    const problem = e instanceof Error ? e.message : "GitHub could not be reached.";
    if (githubProblem.get(app) !== problem) {
      githubProblem.set(app, problem);
      app.hub.emit({ t: "settings" });
    }
  }
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
/** A failed read (logged out, `gh` missing or slow) is remembered briefly: the poller, the watchers and every sandbox ask for the token. */
const GH_FAIL_TTL_MS = 15_000;
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
  if (cached && app.now() - cached.at < ("token" in cached.login ? GH_TTL_MS : GH_FAIL_TTL_MS)) return cached.login;
  const login = await app.ghLogin();
  // The token this process last confirmed. On the first read after a restart it is unknown, and gh may have switched accounts
  // meanwhile, so the remembered login is dropped then too: the poller and the repository list learn it again.
  if ("token" in login && confirmed.get(app) !== login.token) {
    update(app.db, "settings", { id: 1 }, { githubLogin: null });
    confirmed.set(app, login.token);
  }
  // A failure is cached for less long, so a `gh auth login` is picked up within seconds (connecting calls `forgetGhLogin` at once).
  ghCache.set(app, { at: app.now(), login });
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
export async function antigravityToken(app: App): Promise<string | undefined> {
  const s = readSettings(app);
  return s.antigravityTokenEnc ? decrypt(app.ring, s.antigravityTokenEnc, aad.antigravityToken(OWNER)) : undefined;
}
export async function cliSecrets(app: App): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of app.db.all<{ name: string; value_enc: string }>("SELECT name, value_enc FROM secrets ORDER BY name")) out[r.name] = await decrypt(app.ring, r.value_enc, aad.secret(OWNER, r.name));
  return out;
}
