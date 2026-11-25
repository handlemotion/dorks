// A small Sentry API client for automations' Sentry triggers (docs/automations.md, "Sentry"). It reads with the owner's Sentry token
// (a personal token with org:read, project:read and event:read) from the organization's own region (`links.regionUrl`), or from a
// self-hosted Sentry. Failures are SentryError with a reason a person can be told about.

export const SENTRY_URL = "https://sentry.io";

export type SentryFailure = "auth" | "forbidden" | "not_found" | "rate_limited" | "unreachable" | "bad_response";

export class SentryError extends Error {
  constructor(
    readonly reason: SentryFailure,
    readonly status?: number,
    /** When a rate limit lifts (ms since the epoch). */
    readonly retryAt?: number,
  ) {
    super(`sentry: ${reason}${status ? ` (${status})` : ""}`);
  }
}

export interface SentryClient {
  fetch: typeof fetch;
  token: string;
  /** The API's origin: `https://us.sentry.io`, `https://de.sentry.io`, a self-hosted URL. */
  base: string;
  now: () => number;
}

/** `https://sentry.example.com/` → `https://sentry.example.com`; anything that is not an http(s) URL is refused. */
export function sentryOrigin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** One GET under `/api/0`, parsed as JSON. */
export async function sentryGet<T>(c: SentryClient, path: string): Promise<T> {
  return (await sentryPage<T>(c, path)).json;
}

/** The next page's cursor from Sentry's `Link` header, when it says there are more results. */
const nextCursor = (link: string | null) => /<[^>]*>;\s*rel="next";\s*results="true";\s*cursor="([^"]+)"/.exec(link ?? "")?.[1];

async function sentryPage<T>(c: SentryClient, path: string): Promise<{ json: T; next?: string }> {
  let res: Response;
  try {
    res = await c.fetch(`${c.base}/api/0${path}`, { headers: { Authorization: `Bearer ${c.token}`, Accept: "application/json", "User-Agent": "dorks" } });
  } catch {
    throw new SentryError("unreachable");
  }
  if (res.status === 401) throw new SentryError("auth", 401);
  if (res.status === 403) throw new SentryError("forbidden", 403);
  if (res.status === 404) throw new SentryError("not_found", 404);
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-sentry-rate-limit-reset"));
    const after = Number(res.headers.get("retry-after"));
    throw new SentryError("rate_limited", 429, reset ? reset * 1000 : after ? c.now() + after * 1000 : undefined);
  }
  if (!res.ok) throw new SentryError(res.status >= 500 ? "unreachable" : "bad_response", res.status);
  try {
    return { json: (await res.json()) as T, next: nextCursor(res.headers.get("link")) };
  } catch {
    throw new SentryError("bad_response", res.status);
  }
}

/** An issue as the organization issues list returns it: only the fields the watcher reads. */
export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string | null;
  permalink: string;
  level?: string;
  status?: string;
  /** Events in the requested period (`statsPeriod`), as a string. */
  count: string | number;
  userCount?: number;
  firstSeen: string;
  lastSeen: string;
  issueCategory?: string;
  issueType?: string;
}

const isIssue = (x: unknown): x is SentryIssue => {
  const i = x as Partial<SentryIssue> | null;
  return !!i && typeof i.id === "string" && typeof i.title === "string" && typeof i.permalink === "string" && typeof i.firstSeen === "string";
};

/** `GET /organizations/:org/issues/` with `params`; items that do not look like issues are dropped. */
export async function listIssues(c: SentryClient, org: string, params: Record<string, string | undefined>): Promise<SentryIssue[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  q.append("collapse", "stats");
  q.append("collapse", "unhandled");
  const list = await sentryGet<unknown>(c, `/organizations/${encodeURIComponent(org)}/issues/?${q}`);
  if (!Array.isArray(list)) throw new SentryError("bad_response");
  return list.filter(isIssue);
}

/** The organization's own API origin (its region), checking the token can read it. */
export async function organizationApi(c: SentryClient, org: string): Promise<string> {
  const o = await sentryGet<{ slug?: unknown; links?: { regionUrl?: unknown } }>(c, `/organizations/${encodeURIComponent(org)}/`);
  const region = typeof o.links?.regionUrl === "string" ? sentryOrigin(o.links.regionUrl) : null;
  return region ?? c.base;
}

/** The project's numeric id, which the issues list filters by. */
export async function projectId(c: SentryClient, org: string, project: string): Promise<string> {
  const p = await sentryGet<{ id?: unknown }>(c, `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`);
  if (typeof p.id !== "string" && typeof p.id !== "number") throw new SentryError("bad_response");
  return String(p.id);
}

/** The organization's project slugs, for the trigger editor (at most 500). */
export async function listProjects(c: SentryClient, org: string): Promise<{ slug: string; name: string; platform: string | null }[]> {
  const out: { slug: string; name: string; platform: string | null }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const { json: list, next } = await sentryPage<unknown>(c, `/organizations/${encodeURIComponent(org)}/projects/?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(list)) throw new SentryError("bad_response");
    for (const p of list as { slug?: unknown; name?: unknown; platform?: unknown }[])
      if (typeof p.slug === "string") out.push({ slug: p.slug, name: typeof p.name === "string" ? p.name : p.slug, platform: typeof p.platform === "string" ? p.platform : null });
    if (!next) break;
    cursor = next;
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

interface SentryFrame {
  filename?: string | null;
  absPath?: string | null;
  module?: string | null;
  function?: string | null;
  lineNo?: number | null;
  inApp?: boolean | null;
}
interface SentryEventBody {
  message?: string | null;
  dateCreated?: string;
  release?: { version?: string } | string | null;
  tags?: { key: string; value: string }[];
  entries?: { type: string; data?: any }[];
}

const MAX_FRAMES = 12;

type SentryException = { type?: string; value?: string; stacktrace?: { frames?: SentryFrame[] } };

const frameLine = (f: SentryFrame) => `  at ${f.function ?? "?"} (${f.filename ?? f.absPath ?? f.module ?? "?"}${f.lineNo ? `:${f.lineNo}` : ""})`;

/** The last two exceptions, each with its innermost in-app frames (all frames when none is in-app). */
function exceptionLines(exceptions: SentryException[]): string[] {
  return exceptions.slice(-2).flatMap((x) => {
    const frames = x.stacktrace?.frames ?? [];
    const inApp = frames.filter((f) => f.inApp);
    // Sentry lists frames outermost first: the innermost (where it threw) are last.
    return [`${x.type ?? "Error"}: ${x.value ?? ""}`.trim(), ...(inApp.length ? inApp : frames).slice(-MAX_FRAMES).toReversed().map(frameLine)];
  });
}

/** The request, release, environment and time, those that are there. */
function contextLines(e: SentryEventBody, request: { url?: string; method?: string } | undefined): string[] {
  const release = typeof e.release === "string" ? e.release : e.release?.version;
  const env = e.tags?.find((t) => t.key === "environment")?.value;
  return [request?.url && `Request: ${request.method ?? "GET"} ${request.url}`, release && `Release: ${release}`, env && `Environment: ${env}`, e.dateCreated && `At: ${e.dateCreated}`].filter(
    (l): l is string => !!l,
  );
}

/**
 * An issue's latest event in a few lines: the exception, its innermost in-app frames, the request, the release. Null when it cannot be
 * read. The text comes from the app's error data, so the caller quotes it as untrusted.
 */
export async function latestEventDigest(c: SentryClient, org: string, issueId: string): Promise<string | null> {
  let e: SentryEventBody;
  try {
    e = await sentryGet<SentryEventBody>(c, `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/events/latest/`);
  } catch {
    return null;
  }
  const entry = (type: string) => e.entries?.find((x) => x.type === type)?.data;
  const exceptions: SentryException[] = entry("exception")?.values ?? [];
  const lines = [...(exceptions.length ? exceptionLines(exceptions) : e.message ? [e.message] : []), ...contextLines(e, entry("request"))];
  return lines.length ? lines.join("\n").slice(0, 3_000) : null;
}

/** What a failure means for the person who set it up. */
export function sentryProblem(e: SentryError, what: string): string | null {
  if (e.reason === "auth") return "Sentry rejected the saved token. Save a new one in Settings, Sentry.";
  if (e.reason === "forbidden") return `Your Sentry token cannot read the ${what}. It needs org:read, project:read and event:read.`;
  if (e.reason === "not_found") return `Sentry has no ${what} that your token can see.`;
  return null;
}
