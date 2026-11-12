import type { AppError, AppErrorCode } from "@dorks/shared";
import { Context, Data, Effect, Schema } from "effect";
import type { Context as HonoContext, Handler } from "hono";
import { AppFail, type App } from "../app";

// How the UI API runs on Hono: each route is an Effect program. Hono does the HTTP (routing, CORS, auth, SSE); the handler
// decodes its input with Schema, calls the services through `AppEnv`, and fails with a typed `ApiError` that becomes the
// `{ error: { code, message } }` body of docs/architecture.md ("UI API"). Anything else is a defect: Hono's onError logs it and
// answers a generic 500.

/** The app the handlers act on. */
export class AppEnv extends Context.Service<AppEnv, App>()("dorks/server/AppEnv") {}

/** A failure the user may see: its code picks the HTTP status. */
export class ApiError extends Data.TaggedError("ApiError")<{ readonly error: AppError }> {
  static of(code: AppErrorCode, message: string) {
    return new ApiError({ error: { code, message } as AppError });
  }
}

export const STATUS: Record<AppErrorCode, number> = {
  invalid: 400, not_found: 404, forbidden: 401, limit: 429, rate_limited: 429, archived: 409, deleting: 409, conflict: 409, sleeping: 409,
  onboarding_incomplete: 412, not_configured: 412, too_many_frames: 413, event_too_large: 413, github_error: 502, timeout: 504, turn_failed: 500, failed: 500,
};

export const errBody = (error: AppError) => ({ error });

/** A service's `AppFail` is the user-facing `ApiError`; anything else stays a defect. */
const classify = (e: unknown): Effect.Effect<never, ApiError> => (e instanceof AppFail ? Effect.fail(new ApiError({ error: e.error })) : Effect.die(e));

/** Runs a synchronous service call with the app. Its `AppFail` becomes `ApiError`. */
export const service = <A>(f: (app: App) => A): Effect.Effect<A, ApiError, AppEnv> =>
  AppEnv.use((app) =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(f(app));
      } catch (e) {
        return classify(e);
      }
    }),
  );

/** Like `service`, for a call that returns a Promise. */
export const serviceAsync = <A>(f: (app: App) => Promise<A>): Effect.Effect<A, ApiError, AppEnv> =>
  AppEnv.use((app) => Effect.tryPromise({ try: () => f(app), catch: (e) => e }).pipe(Effect.catch(classify)));

/** An empty body is `{}`; anything but a JSON object is `invalid`. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const readObject = (c: HonoContext) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => c.req.text());
    if (!text) return {};
    const value = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: () => ApiError.of("invalid", "bad JSON") });
    if (!Schema.is(JsonObject)(value) || Array.isArray(value)) return yield* ApiError.of("invalid", "body must be an object");
    return value;
  });

/**
 * The request's JSON body decoded with `schema`. A body that does not match fails with `invalid` and `message` (or the schema's
 * own description of the problem), so the services only ever see well-formed input.
 */
export const body = <S extends Schema.Constraint & { readonly DecodingServices: never }>(c: HonoContext, schema: S, message?: string) =>
  readObject(c).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((e) => ApiError.of("invalid", message ?? e.message.split("\n")[0].slice(0, 200)))),
    ),
  );

/** The untyped body, for services that validate their own input (settings, builds). */
export const looseBody = readObject;

/** An optional integer query parameter; anything else is `invalid`. */
export const intQuery = (c: HonoContext, name: string): Effect.Effect<number | undefined, ApiError> => {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return Effect.succeed(undefined);
  const n = Number(raw);
  return Number.isFinite(n) ? Effect.succeed(n) : Effect.fail(ApiError.of("invalid", "bad number"));
};

/**
 * A Hono handler from an Effect program. `ApiError` becomes its status and `{ error }` body; a defect is rethrown for Hono's
 * onError, which logs it without the request's content.
 */
export const route = (app: App, f: (c: HonoContext) => Effect.Effect<Response, ApiError, AppEnv>): Handler => (c) =>
  Effect.runPromise(
    f(c).pipe(
      Effect.catchTag("ApiError", ({ error }) => Effect.succeed(c.json(errBody(error), STATUS[error.code] as 400))),
      Effect.provideService(AppEnv, app),
    ),
  );

/** `{}` with 200: the answer of every command that returns nothing. */
export const ok = (c: HonoContext) => (effect: Effect.Effect<unknown, ApiError, AppEnv>) => effect.pipe(Effect.as(c.json({})));
