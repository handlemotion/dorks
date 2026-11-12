import { Clock, Data, Effect, Option, Schema } from "effect";

// The Boat HTTP client, in Effect: one typed error (`BoatError`), schema-decoded responses, and the poll and retry loops the
// sandbox and snapshot drivers share. The drivers expose Promise interfaces (core/box.ts, core/snapshot.ts) by running these
// effects at their edge, so the lifecycle code that calls them is unchanged.

export const DEFAULT_BASE_URL = "https://boat.dev/api/v1";
export const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const READY = new Set(["ready", "idle", "running"]);
export const POLL_MS = 2_000;

/** A failed Boat call. Carries the HTTP status and Boat's error code, never the response body. */
export class BoatError extends Data.TaggedError("BoatError")<{ readonly message: string; readonly status?: number; readonly code?: string }> {
  constructor(message: string, status?: number, code?: string) {
    super({ message, status, code });
  }
}

export const isBoatStatus = (e: unknown, ...statuses: number[]): boolean => e instanceof BoatError && e.status !== undefined && statuses.includes(e.status);

/** Worth asking again with the same idempotency key: Boat is still working on it, had a server error, or the network failed. */
export const isTransient = (e: BoatError) => e.code === "idempotency_in_progress" || isBoatStatus(e, 500, 502, 503) || e.message.includes("network error");

export type BoatOptions = {
  apiKey: string;
  scope: string;
  org?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type CallOptions = { body?: unknown; headers?: Record<string, string>; timeoutMs?: number };

/** One authenticated JSON call to the Boat API. */
export type BoatCall = (op: string, method: string, path: string, o?: CallOptions) => Effect.Effect<any, BoatError>;

const ErrorBody = Schema.Struct({ code: Schema.optional(Schema.String) });
const codeOf = (json: unknown) => (Schema.is(ErrorBody)(json) ? json.code : undefined);
const readJson = (res: Response) => Effect.promise(() => res.json().catch(() => ({})) as Promise<unknown>);

const headersFor = (opts: Pick<BoatOptions, "apiKey" | "org">, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${opts.apiKey}`,
  ...(opts.org ? { "X-Boat-Org": opts.org } : {}),
  ...extra,
});

/** A raw authenticated request; fails on network errors and non-2xx answers (`op` names the call in the error). */
export const boatFetch = (opts: Pick<BoatOptions, "apiKey" | "org" | "fetch">, op: string, path: string, init: RequestInit & { timeoutMs: number }) =>
  Effect.gen(function* () {
    const doFetch = opts.fetch ?? fetch;
    const res = yield* Effect.tryPromise({
      try: () => doFetch(`${DEFAULT_BASE_URL}${path}`, { ...init, headers: headersFor(opts, init.headers as Record<string, string>), signal: AbortSignal.timeout(init.timeoutMs) }),
      catch: (e) => new BoatError(`boat ${op}: network error (${e instanceof Error ? e.name : "unknown"})`),
    });
    if (res.ok) return res;
    const code = codeOf(yield* readJson(res));
    const hint = res.status === 401 || res.status === 403 ? "; check the Boat API key and its access" : "";
    return yield* new BoatError(`boat ${op}: HTTP ${res.status}${hint}`, res.status, code);
  });

const Refused = Schema.Struct({ ok: Schema.Literal(false) });

export function makeBoatCall(opts: Pick<BoatOptions, "apiKey" | "org" | "fetch">): BoatCall {
  return (op, method, path, o = {}) =>
    Effect.gen(function* () {
      const res = yield* boatFetch(opts, op, path, {
        method,
        headers: { ...(o.body === undefined ? {} : { "Content-Type": "application/json" }), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        timeoutMs: o.timeoutMs ?? 30_000,
      });
      const json = yield* readJson(res);
      if (Schema.is(Refused)(json)) return yield* new BoatError(`boat ${op}: invalid success response`, res.status);
      return json;
    });
}

/** Decodes a response, failing with `message` (no response content) when it does not match. */
export const decodeOr =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, message: string) =>
  (json: unknown) =>
    Schema.decodeUnknownEffect(schema)(json).pipe(Effect.mapError(() => new BoatError(message)));

/** Turns a 404 (the thing is gone) into `none`. */
export const optionalOn404 = <A, R>(self: Effect.Effect<A, BoatError, R>): Effect.Effect<Option.Option<A>, BoatError, R> =>
  self.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (e) => isBoatStatus(e, 404),
      () => Effect.succeed(Option.none<A>()),
    ),
  );

/** Ignores the given HTTP statuses (idempotent deletes and stops). */
export const ignoreStatus =
  (...statuses: number[]) =>
  <A, R>(self: Effect.Effect<A, BoatError, R>): Effect.Effect<void, BoatError, R> =>
    self.pipe(
      Effect.asVoid,
      Effect.catchIf(
        (e) => isBoatStatus(e, ...statuses),
        () => Effect.void,
      ),
    );

/** Waits `ms`. The drivers take a `sleep` so tests do not wait in real time. */
export const pauseWith = (sleep: BoatOptions["sleep"]) => (ms: number) => (sleep ? Effect.promise(() => sleep(ms)) : Effect.sleep(ms));

/**
 * Re-runs `step` every `everyMs` until it answers a value, failing with `onTimeout()` once `withinMs` has passed. The deadline
 * is wall-clock (Clock), so it holds however long each step takes.
 */
export const pollUntil = <A, E, R, E2>(
  step: Effect.Effect<Option.Option<A>, E, R>,
  o: { everyMs: number; withinMs: number; pause: (ms: number) => Effect.Effect<void>; onTimeout: () => E2 },
): Effect.Effect<A, E | E2, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + o.withinMs;
    for (;;) {
      const found = yield* step;
      if (Option.isSome(found)) return found.value;
      if ((yield* Clock.currentTimeMillis) >= deadline) return yield* Effect.fail(o.onTimeout());
      yield* o.pause(o.everyMs);
    }
  });

/** Retries `self` every `everyMs` while it fails with an error `retryable` accepts, for at most `withinMs`; then fails with that error. */
export const retryWhile = <A, R>(
  self: Effect.Effect<A, BoatError, R>,
  o: { retryable: (e: BoatError) => boolean; everyMs: number; withinMs: number; pause: (ms: number) => Effect.Effect<void> },
): Effect.Effect<A, BoatError, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + o.withinMs;
    const giveUp = (e: BoatError) => Clock.currentTimeMillis.pipe(Effect.map((now) => !o.retryable(e) || now >= deadline));
    for (;;) {
      const result = yield* Effect.result(self);
      if (result._tag === "Success") return result.success;
      if (yield* giveUp(result.failure)) return yield* Effect.fail(result.failure);
      yield* o.pause(o.everyMs);
    }
  });

/** A sandbox as Boat reports it. */
export const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dataExpiredAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type Sandbox = typeof Sandbox.Type;

/** `true` when the sandbox is gone for good: cancelled, or its saved data expired. */
export const isGone = (s: Sandbox) => s.state === "cancelled" || !!s.dataExpiredAt;

const SandboxResponse = Schema.Struct({ sandbox: Sandbox });
const SandboxPage = Schema.Struct({
  sandboxes: Schema.Array(Schema.Unknown),
  pageInfo: Schema.optional(Schema.NullOr(Schema.Struct({ nextCursor: Schema.optional(Schema.NullOr(Schema.String)) }))),
});

export const sandboxPath = (id: string, suffix = ""): Effect.Effect<string, BoatError> =>
  BOX_ID.test(id) ? Effect.succeed(`/sandboxes/${id}${suffix}`) : Effect.fail(new BoatError("boat: invalid sandbox id"));

/** The sandbox, or `none` when Boat no longer knows it. */
export const getSandbox = (call: BoatCall, id: string) =>
  sandboxPath(id).pipe(
    Effect.flatMap((p) => call("get", "GET", p)),
    Effect.flatMap(decodeOr(SandboxResponse, "boat get: invalid sandbox response")),
    Effect.map((r) => r.sandbox),
    optionalOn404,
  );

/** Every sandbox carrying the label `key=value`, following Boat's cursor pages. Entries that are not well-formed are skipped. */
export const listSandboxes = (call: BoatCall, key: string, value: string) =>
  Effect.gen(function* () {
    const found: Sandbox[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ label: `${key}=${value}`, limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = yield* call("list", "GET", `/sandboxes?${query}`).pipe(Effect.flatMap(decodeOr(SandboxPage, "boat list: invalid response")));
      found.push(...page.sandboxes.filter(Schema.is(Sandbox)).filter((b) => BOX_ID.test(b.id) && b.labels?.[key] === value));
      cursor = page.pageInfo?.nextCursor || undefined;
    } while (cursor);
    return found;
  });

/** Deletes a sandbox; a missing one is not an error. */
export const deleteSandbox = (call: BoatCall, id: string) =>
  sandboxPath(id).pipe(
    Effect.flatMap((p) => call("delete", "DELETE", p, { headers: { "X-Ascii-Confirm-Delete": id } })),
    ignoreStatus(404),
  );

/** The id of a sandbox in a create response. */
export const createdId = (json: unknown) =>
  decodeOr(
    Schema.Struct({ sandbox: Schema.Struct({ id: Schema.String }) }),
    "boat create: response had no usable sandbox id",
  )(json).pipe(
    Effect.map((r) => r.sandbox.id),
    Effect.filterOrFail(
      (id) => BOX_ID.test(id),
      () => new BoatError("boat create: response had no usable sandbox id"),
    ),
  );
