import { Effect, Schema } from "effect";
import type { App } from "../app";
import { decodeOr, makeBoatCall } from "../lib/boatHttp";
import { antigravityToken, boatKey, claudeToken, readSettings, updateSettings } from "./settings";

/** A rolling limit: `used` is 0..1, `resetsAt` epoch ms. */
export interface UsageWindow {
  used: number;
  resetsAt?: number;
}

/** `GET /api/usage`: what the composer's usage menu shows. A part is missing when its credential is not set or its source failed. */
export interface Usage {
  /** The Claude subscription behind `claudeToken`: the 5-hour session and the weekly limit. */
  claude?: { session?: UsageWindow; weekly: UsageWindow };
  /** The Google AI plan behind Antigravity's sign-in: its Gemini models' 5-hour and weekly limits. */
  google?: { session?: UsageWindow; weekly: UsageWindow };
  /** The Boat account: machine time included in the plan this period (hours), its start and concurrency limits, the wallet. */
  cloud?: {
    usedHours?: number;
    includedHours?: number;
    periodEnd?: number;
    /** The plan's price as Boat shows it, `$20/mo`. */
    plan?: string;
    /** Sandboxes running now, of the most that may run at once. */
    sandboxes?: UsageCount;
    /** Sandbox starts in the last hour and day, of the plan's limits (more cost extra from the wallet). */
    startsHour?: UsageCount;
    startsDay?: UsageCount;
    /** What pays for use past the plan, in dollars. */
    walletDollars?: number;
    /** Set when Boat refuses new starts: its reason. */
    blocked?: string;
  };
}

/** A count against a limit. */
export interface UsageCount {
  used: number;
  limit: number;
}

const TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;
const cache = new WeakMap<App, { at: number; value: Usage }>();
/** The read in progress, shared by every caller that arrives while it runs (several windows polling at once read once). */
const pending = new WeakMap<App, Promise<Usage>>();

/**
 * Usage of the accounts Dorks runs on, cached for a minute (the web app polls it every 30 s while visible).
 *
 * - **Claude.** A `claude setup-token` token only has the `user:inference` scope, so `GET /api/oauth/usage` (the endpoint behind
 *   Claude Code's `/usage`) answers 403 `oauth_scope_insufficient`. Every Messages response carries the subscription's unified
 *   rate-limit headers instead (`anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization` and their resets), so one
 *   1-token Haiku request reads them. `count_tokens` does not return them.
 * - **Cloud.** Boat's `GET /limits` (the `account.read` action, already used by the Boat step) reports the plan's included VM time
 *   and what is left of it, the sandbox start limits and what was started, concurrent sandboxes and the wallet.
 * - **Google.** agy's own `/usage` (`agy -p /usage --output-format json`, lib/agyCli.ts) with Antigravity's saved sign-in: quota
 *   groups of buckets, each a `remaining_fraction` and a `reset_time`. The first group is the Gemini models (the one Antigravity
 *   sessions mostly use); the Claude and GPT group and Argon's separate one are left out to keep the menu short.
 * - **Codex** is not here: Dorks never holds the ChatGPT sign-in (Boat installs it inside each sandbox), so only a running Codex
 *   sandbox could read its limits.
 */
export async function getUsage(app: App, force = false): Promise<Usage> {
  const cached = cache.get(app);
  if (!force && cached && app.now() - cached.at < TTL_MS) return cached.value;
  const running = pending.get(app);
  if (running) return running;
  const read = readUsage(app).finally(() => pending.delete(app));
  pending.set(app, read);
  return read;
}

async function readUsage(app: App): Promise<Usage> {
  const [claude, google, cloud] = await Promise.all([claudeUsage(app).catch(() => undefined), googleUsage(app).catch(() => undefined), cloudUsage(app).catch(() => undefined)]);
  const value: Usage = { ...(claude ? { claude } : {}), ...(google ? { google } : {}), ...(cloud ? { cloud } : {}) };
  cache.set(app, { at: app.now(), value });
  return value;
}

/** Drop the cache, so a changed token or key shows on the next read. */
export function forgetUsage(app: App): void {
  cache.delete(app);
}

async function claudeUsage(app: App): Promise<Usage["claude"]> {
  const token = await claudeToken(app);
  if (!token) return undefined;
  const res = await app.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  const h = (name: string) => res.headers.get(`anthropic-ratelimit-unified-${name}`);
  const window = (key: "5h" | "7d"): UsageWindow | undefined => {
    const used = Number(h(`${key}-utilization`));
    if (h(`${key}-utilization`) === null || !Number.isFinite(used)) return undefined;
    const reset = Number(h(`${key}-reset`));
    return { used: Math.min(Math.max(used, 0), 1), ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset * 1000 } : {}) };
  };
  const session = window("5h");
  const weekly = window("7d");
  // The 5-hour headers are absent while no session window is open (nothing used in the last five hours); the weekly ones always come.
  if (!weekly) {
    console.error("usage: claude", res.status); // status only, never the body
    return undefined;
  }
  return session ? { session, weekly } : { weekly };
}

type Bucket = { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };

async function googleUsage(app: App): Promise<Usage["google"]> {
  const token = await antigravityToken(app);
  if (!token) return undefined;
  const read = await app.agyCli.usage(token);
  if (!read) return undefined;
  // agy refreshed its sign-in while reading: keep the new one, so sandboxes and the next read start from it.
  if (read.token) await updateSettings(app, { antigravityToken: read.token }).catch(() => {});
  return googleWindows(read.data);
}

/** The first quota group's 5-hour and weekly buckets, as used shares. */
export function googleWindows(data: unknown): Usage["google"] {
  const groups = (data as { groups?: { buckets?: Bucket[] }[] } | undefined)?.groups;
  const buckets = Array.isArray(groups) && Array.isArray(groups[0]?.buckets) ? groups[0].buckets : [];
  const window = (name: string): UsageWindow | undefined => {
    const b = buckets.find((x) => x.window === name);
    const left = Number(b?.remaining_fraction);
    if (!b || !Number.isFinite(left)) return undefined;
    const reset = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : NaN;
    return { used: Math.min(Math.max(1 - left, 0), 1), ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) };
  };
  const weekly = window("weekly");
  if (!weekly) return undefined;
  const session = window("5h");
  return session ? { session, weekly } : { weekly };
}

const Window = Schema.optional(Schema.NullOr(Schema.Struct({ limit: Schema.optional(Schema.Unknown), used: Schema.optional(Schema.Unknown) })));

/** `GET /limits`, the parts this reads. Numbers may come as strings, so they are read with `Number`. */
const Limits = Schema.Struct({
  planIncluded: Schema.optional(
    Schema.NullOr(Schema.Struct({ vmHours: Schema.optional(Schema.Unknown), vmHoursRemaining: Schema.optional(Schema.Unknown), periodEnd: Schema.optional(Schema.Unknown) })),
  ),
  canStart: Schema.optional(Schema.Unknown),
  startBlockedReason: Schema.optional(Schema.Unknown),
  activeSandboxes: Schema.optional(Schema.Unknown),
  maxActiveSandboxes: Schema.optional(Schema.Unknown),
  starts: Schema.optional(Schema.NullOr(Schema.Struct({ unlimited: Schema.optional(Schema.Unknown), hour: Window, day: Window }))),
  wallet: Schema.optional(Schema.NullOr(Schema.Struct({ balanceDollars: Schema.optional(Schema.Unknown) }))),
  sandboxPlanKey: Schema.optional(Schema.Unknown),
  sandboxPlanTiers: Schema.optional(Schema.Array(Schema.Struct({ key: Schema.optional(Schema.Unknown), displayPrice: Schema.optional(Schema.Unknown) }))),
});

/** A count against its limit, when Boat reports both as numbers (a missing or null limit is unlimited: left out). */
const count = (used: unknown, limit: unknown): UsageCount | undefined => {
  const u = Number(used);
  const l = Number(limit);
  return used != null && limit != null && Number.isFinite(u) && Number.isFinite(l) && l > 0 ? { used: Math.max(u, 0), limit: l } : undefined;
};

type BoatLimits = typeof Limits.Type;

/** The plan's included machine time this period, in hours. */
function includedHours(p: BoatLimits["planIncluded"]) {
  const included = Number(p?.vmHours);
  const remaining = Number(p?.vmHoursRemaining);
  if (!Number.isFinite(included) || included <= 0 || !Number.isFinite(remaining)) return {};
  const end = typeof p?.periodEnd === "string" ? Date.parse(p.periodEnd) : NaN;
  return { usedHours: Math.max(included - remaining, 0), includedHours: included, ...(Number.isFinite(end) ? { periodEnd: end } : {}) };
}

/** Starts in the last hour and day against the plan's limits; nothing for an account without start limits. */
function startCounts(starts: BoatLimits["starts"]) {
  if (!starts || starts.unlimited === true) return {};
  const hour = count(starts.hour?.used, starts.hour?.limit);
  const day = count(starts.day?.used, starts.day?.limit);
  return { ...(hour ? { startsHour: hour } : {}), ...(day ? { startsDay: day } : {}) };
}

/** Why Boat refuses new starts, when it does. */
function blockedReason(l: BoatLimits) {
  if (l.canStart !== false) return {};
  return { blocked: typeof l.startBlockedReason === "string" && l.startBlockedReason ? l.startBlockedReason.slice(0, 120) : "Boat cannot start sandboxes" };
}

/** What the usage menu shows for Boat: included machine time, starts, running sandboxes, the wallet, and why starts are refused. */
export function planUsage(l: BoatLimits): Usage["cloud"] {
  const sandboxes = count(l.activeSandboxes, l.maxActiveSandboxes);
  const wallet = Number(l.wallet?.balanceDollars);
  const tier = l.sandboxPlanTiers?.find((t) => t.key === l.sandboxPlanKey)?.displayPrice;
  const cloud: NonNullable<Usage["cloud"]> = {
    ...includedHours(l.planIncluded),
    ...(typeof tier === "string" && tier ? { plan: tier } : {}),
    ...(sandboxes ? { sandboxes } : {}),
    ...startCounts(l.starts),
    ...(l.wallet && Number.isFinite(wallet) ? { walletDollars: wallet } : {}),
    ...blockedReason(l),
  };
  return Object.keys(cloud).length ? cloud : undefined;
}

async function cloudUsage(app: App): Promise<Usage["cloud"]> {
  if (app.cfg.boxProvider === "sim") return undefined;
  const apiKey = await boatKey(app);
  if (!apiKey) return undefined;
  const call = makeBoatCall({ apiKey, org: readSettings(app).boatOrg, fetch: app.fetch });
  return Effect.runPromise(
    call("usage", "GET", "/limits", { timeoutMs: TIMEOUT_MS }).pipe(
      Effect.flatMap(decodeOr(Limits, "boat usage: invalid response")),
      Effect.map(planUsage),
      Effect.catch((e) =>
        Effect.sync(() => {
          console.error("usage: boat", e.status ?? "network");
          return undefined;
        }),
      ),
    ),
  );
}
