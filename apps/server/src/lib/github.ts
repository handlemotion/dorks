import { Data, Effect, Schema } from "effect";

// Minimal GitHub REST client for the poller, in Effect: bearer token, conditional requests (ETag), one typed error
// (`GithubError`), schema-decoded responses, no SDK. Code outside Effect (the stall comment job) runs it at its Promise edge;
// `Effect.runPromise` rejects with the original `GithubError`, so `instanceof` checks keep working there.
const API = "https://api.github.com";
const UA = "dorks";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA };
const TIMEOUT_MS = 20_000;

/**
 * Why a GitHub call failed: `rate_limited` (with `retryAt`), `not_visible` (404: missing, or hidden from the token), `auth`
 * (401/403 without a rate limit), `http` (any other non-2xx), `network` (no answer), `timeout`, `invalid_response` (the body
 * did not decode).
 */
export type GithubFailure = "rate_limited" | "not_visible" | "auth" | "http" | "network" | "timeout" | "invalid_response";

/** A failed GitHub call. Carries the HTTP status when there was one, never the response body. */
export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: GithubFailure;
  readonly message: string;
  readonly status?: number;
  /** Epoch ms when a rate limit lifts, when GitHub said so. */
  readonly retryAt?: number;
}> {}

/**
 * 5xx, rate limiting or a network error: worth retrying on the next tick. 4xx/config errors will not fix themselves, and neither
 * is a timeout retried (the request may have landed).
 */
export const isTransientGithubError = (e: unknown) =>
  e instanceof GithubError && (e.reason === "network" || e.retryAt !== undefined || (e.status !== undefined && (e.status >= 500 || e.status === 429)));

export type Cached<T> = { status: 304 } | { status: 200; etag?: string; json: T };

/** What every call needs: the fetch to use, the token, and the clock (rate limits are reported in epoch ms). */
export interface GithubClient {
  fetch: typeof fetch;
  token: string;
  now: () => number;
}

/** A Schema with no decoding services, to decode a response body. */
type Decoder = Schema.Constraint & { readonly DecodingServices: never };

/** When a 403/429 is a rate limit: from `retry-after`, else `x-ratelimit-reset`, else a minute. */
function rateLimitedUntil(res: Response, now: number): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.headers.get("x-ratelimit-remaining") !== "0" && !(retryAfter > 0)) return undefined;
  if (retryAfter > 0) return now + retryAfter * 1000;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return reset > 0 ? reset * 1000 : now + 60_000;
}

function httpError(res: Response, what: string, now: number): GithubError {
  const message = `GitHub ${what} failed: ${res.status}`;
  const retryAt = rateLimitedUntil(res, now);
  if (retryAt !== undefined) return new GithubError({ reason: "rate_limited", message, status: res.status, retryAt });
  const reason: GithubFailure = res.status === 404 ? "not_visible" : res.status === 401 || res.status === 403 ? "auth" : "http";
  return new GithubError({ reason, message, status: res.status });
}

/** One request; fails on no answer and on non-2xx answers other than 304. `what` names the call in the error. */
const request = (gh: GithubClient, what: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => gh.fetch(`${API}${path}`, { ...init, headers: { ...HEADERS, Authorization: `Bearer ${gh.token}`, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      catch: (e) =>
        e instanceof Error && e.name === "TimeoutError"
          ? new GithubError({ reason: "timeout", message: `GitHub ${what} timed out` })
          : new GithubError({ reason: "network", message: `GitHub ${what} failed: network error` }),
    });
    if (res.ok || res.status === 304) return res;
    return yield* httpError(res, what, gh.now());
  });

/** Reads and decodes a JSON body, failing with `invalid_response` (no response content) when it does not match. */
const decodeBody = <S extends Decoder>(schema: S, res: Response, what: string) =>
  Effect.tryPromise({ try: () => res.json() as Promise<unknown>, catch: () => undefined }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => new GithubError({ reason: "invalid_response", message: `GitHub ${what}: invalid response`, status: res.status })),
  );

/** GET with `If-None-Match` when an ETag is known; a 304 costs nothing against the rate limit. `path` starts with `/`. */
export const getCached = <S extends Decoder>(gh: GithubClient, schema: S, path: string, etag?: string): Effect.Effect<Cached<S["Type"]>, GithubError> =>
  Effect.gen(function* () {
    const what = path.split("?")[0];
    const res = yield* request(gh, what, path, { headers: etag ? { "If-None-Match": etag } : {} });
    if (res.status === 304) return { status: 304 } as const;
    const json = yield* decodeBody(schema, res, what);
    return { status: 200, etag: res.headers.get("etag") ?? undefined, json } as const;
  });

/** `POST /repos/{repo}/issues/{number}/comments`: a PR conversation comment, posted as whoever owns the token. */
export const createIssueCommentEffect = (gh: GithubClient, repo: string, number: number, body: string): Effect.Effect<void, GithubError> =>
  request(gh, "comment", `/repos/${repo}/issues/${number}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }).pipe(Effect.asVoid);

/** The Promise form, for the stall comment job (lifecycle/jobs.ts). Rejects with the `GithubError`. */
export const createIssueComment = (fetcher: typeof fetch, token: string, repo: string, number: number, body: string): Promise<void> =>
  Effect.runPromise(createIssueCommentEffect({ fetch: fetcher, token, now: Date.now }, repo, number, body));

// ---- the responses the poller reads. Only the fields it uses; anything else GitHub sends is ignored.
const User = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
export type GhUser = typeof User.Type;
const Actor = Schema.optional(Schema.NullOr(User));

export const GhPr = Schema.Struct({
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable: Schema.NullOr(Schema.Boolean),
  merged_by: Actor,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
});
export type GhPr = typeof GhPr.Type;

export const GhReviews = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    state: Schema.String,
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.String,
    user: Actor,
    submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type GhReview = (typeof GhReviews.Type)[number];

export const GhComments = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.String,
    path: Schema.optional(Schema.NullOr(Schema.String)),
    user: Actor,
    created_at: Schema.String,
  }),
);
export type GhComment = (typeof GhComments.Type)[number];

export const GhIssueEvents = Schema.Array(Schema.Struct({ event: Schema.String, actor: Actor, created_at: Schema.String }));

export const GhSuites = Schema.Struct({
  check_suites: Schema.Array(Schema.Struct({ id: Schema.Number, status: Schema.String, conclusion: Schema.NullOr(Schema.String), latest_check_runs_count: Schema.Number })),
});

export const GhViewer = Schema.Struct({ login: Schema.String });

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
