import type { App } from "../app";
import { BoatError, createBoatCall } from "../lib/boat";
import { boatKey, claudeToken, readSettings } from "./settings";

/** A rolling limit: `used` is 0..1, `resetsAt` epoch ms. */
export interface UsageWindow {
  used: number;
  resetsAt?: number;
}

/** `GET /api/usage`: what the sidebar's usage bar shows. A part is missing when its credential is not set or its source failed. */
export interface Usage {
  /** The Claude subscription behind `claudeToken`: the 5-hour session and the weekly limit. */
  claude?: { session: UsageWindow; weekly: UsageWindow };
  /** Boat machine time included in the plan this period, in hours. */
  cloud?: { usedHours: number; includedHours: number; periodEnd?: number };
}

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const cache = new WeakMap<App, { at: number; value: Usage }>();

/**
 * Usage of the accounts Dorks runs on, cached for five minutes.
 *
 * - **Claude.** A `claude setup-token` token only has the `user:inference` scope, so `GET /api/oauth/usage` (the endpoint behind
 *   Claude Code's `/usage`) answers 403 `oauth_scope_insufficient`. Every Messages response carries the subscription's unified
 *   rate-limit headers instead (`anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization` and their resets), so one
 *   1-token Haiku request reads them. `count_tokens` does not return them.
 * - **Cloud.** Boat's `GET /limits` (the `account.read` action, already used by the Boat step) reports the plan's included VM time
 *   and what is left of it.
 * - **Codex** is not here: Dorks never holds the ChatGPT sign-in (Boat installs it inside each sandbox), so only a running Codex
 *   sandbox could read its limits.
 */
export async function getUsage(app: App, force = false): Promise<Usage> {
  const cached = cache.get(app);
  if (!force && cached && app.now() - cached.at < TTL_MS) return cached.value;
  const [claude, cloud] = await Promise.all([claudeUsage(app).catch(() => undefined), cloudUsage(app).catch(() => undefined)]);
  const value: Usage = { ...(claude ? { claude } : {}), ...(cloud ? { cloud } : {}) };
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
  if (!session || !weekly) {
    console.error("usage: claude", res.status); // status only, never the body
    return undefined;
  }
  return { session, weekly };
}

async function cloudUsage(app: App): Promise<Usage["cloud"]> {
  if (app.cfg.boxProvider === "sim") return undefined;
  const apiKey = await boatKey(app);
  if (!apiKey) return undefined;
  const call = createBoatCall({ apiKey, org: readSettings(app).boatOrg, fetch: app.fetch });
  let limits: { planIncluded?: { vmHours?: unknown; vmHoursRemaining?: unknown; periodEnd?: unknown } };
  try {
    limits = await call("usage", "GET", "/limits", undefined, {}, TIMEOUT_MS);
  } catch (e) {
    if (e instanceof BoatError) console.error("usage: boat", e.status ?? "network");
    return undefined;
  }
  const p = limits?.planIncluded;
  const included = Number(p?.vmHours);
  const remaining = Number(p?.vmHoursRemaining);
  if (!Number.isFinite(included) || included <= 0 || !Number.isFinite(remaining)) return undefined;
  const end = typeof p?.periodEnd === "string" ? Date.parse(p.periodEnd) : NaN;
  return { usedHours: Math.max(included - remaining, 0), includedHours: included, ...(Number.isFinite(end) ? { periodEnd: end } : {}) };
}
