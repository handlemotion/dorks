// Minimal GitHub REST client for the poller: bearer token, conditional requests (ETag), no SDK.
const API = "https://api.github.com";
const UA = "dorks";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA };

/** GitHub answered non-2xx (other than 304). Carries only the status: response bodies are never surfaced. */
export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    what = "request",
    /** Epoch ms when a rate limit lifts, when GitHub said so. */ readonly retryAt?: number,
  ) {
    super(`GitHub ${what} failed: ${status}`);
    this.name = "GithubHttpError";
  }
}

/** 5xx, rate limiting or a network error: worth retrying on the next tick. 4xx/config errors will not fix themselves. */
export const isTransientGithubError = (e: unknown) => (e instanceof GithubHttpError ? e.status >= 500 || e.status === 429 || e.retryAt !== undefined : e instanceof TypeError);

export type Cached<T> = { status: 304 } | { status: 200; etag?: string; json: T };

/** GET with `If-None-Match` when an ETag is known; a 304 costs nothing against the rate limit. `path` starts with `/`. */
export async function getCached<T>(fetcher: typeof fetch, token: string, path: string, etag?: string, now = Date.now()): Promise<Cached<T>> {
  const res = await fetcher(`${API}${path}`, { headers: { ...HEADERS, Authorization: `Bearer ${token}`, ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(res.headers.get("retry-after"));
    const limited = (res.status === 403 || res.status === 429) && (remaining === "0" || retryAfter > 0);
    throw new GithubHttpError(res.status, path.split("?")[0], limited ? (retryAfter > 0 ? now + retryAfter * 1000 : reset > 0 ? reset * 1000 : now + 60_000) : undefined);
  }
  return { status: 200, etag: res.headers.get("etag") ?? undefined, json: (await res.json()) as T };
}

/** `POST /repos/{repo}/issues/{number}/comments`: a PR conversation comment, posted as whoever owns the token. */
export async function createIssueComment(fetcher: typeof fetch, token: string, repo: string, number: number, body: string): Promise<void> {
  const res = await fetcher(`${API}/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new GithubHttpError(res.status, "comment");
}

/** Check-suite conclusions → what CI means for the PR. `cancelled` (usually superseded by a newer run), `action_required` and `stale` say nothing about the code. */
export function suiteOutcome(conclusion: string | null): "pass" | "fail" | null {
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "pass";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    default:
      return null;
  }
}
