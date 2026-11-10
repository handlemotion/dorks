import { z } from "zod";

/**
 * The one error shape shared by the backend, the bridge and every UI.
 *
 * A discriminated union on `code`: a `switch (err.code)` is exhaustive, and each variant carries only the extra fields that
 * code needs. `message` is always safe to show to the user (never a stack, token or provider body). The server
 * returns it as the JSON body of a failed UI API call (see `fail` in apps/server/src/app.ts); `@dorks/client` wraps it in an `ApiError`
 * whose `data` is the AppError, and `toAppError` reads it back.
 */
const m = { message: z.string() };

export const appError = z.discriminatedUnion("code", [
  // Caller mistakes: fix the input and retry.
  z.object({ code: z.literal("invalid"), ...m }),
  z.object({ code: z.literal("not_found"), ...m }),
  z.object({ code: z.literal("forbidden"), ...m }),
  z.object({ code: z.literal("limit"), ...m }),
  z.object({ code: z.literal("rate_limited"), ...m, retryAfterMs: z.number().optional() }),
  // The thing exists but is in the wrong state for this request.
  z.object({ code: z.literal("archived"), ...m }),
  z.object({ code: z.literal("deleting"), ...m }),
  z.object({ code: z.literal("conflict"), ...m }),
  z.object({ code: z.literal("sleeping"), ...m }),
  // Setup the user (or operator) has to finish.
  z.object({ code: z.literal("onboarding_incomplete"), ...m }),
  z.object({ code: z.literal("not_configured"), ...m }),
  // Bridge transport limits.
  z.object({ code: z.literal("too_many_frames"), ...m }),
  z.object({ code: z.literal("event_too_large"), ...m }),
  // Upstream or internal failures.
  z.object({ code: z.literal("github_error"), ...m }),
  z.object({ code: z.literal("timeout"), ...m }),
  z.object({ code: z.literal("turn_failed"), ...m }),
  z.object({ code: z.literal("failed"), ...m }),
]);

export type AppError = z.infer<typeof appError>;
export type AppErrorCode = AppError["code"];
export const APP_ERROR_CODES = appError.options.map((o) => o.shape.code.value) as AppErrorCode[];

export const UNKNOWN_ERROR_MESSAGE = "Something went wrong";

export const isAppError = (v: unknown): v is AppError => appError.safeParse(v).success;

/**
 * Normalizes anything thrown (an `ApiError` from `@dorks/client`, a plain Error, a string) to an AppError. Unknown codes and
 * non-app errors become `failed` with a generic message, so internals never reach the UI.
 */
export function toAppError(e: unknown): AppError {
  const data = (e as { data?: unknown } | null | undefined)?.data;
  const parsed = appError.safeParse(data);
  if (parsed.success) return parsed.data;
  const message = (data as { message?: unknown } | null | undefined)?.message; // only a payload under `data`: a plain Error's message may hold internals
  return { code: "failed", message: typeof message === "string" && message ? message : UNKNOWN_ERROR_MESSAGE };
}

/** Worth retrying later without the user changing anything. */
export function isRetryable(err: AppError): boolean {
  switch (err.code) {
    case "rate_limited":
    case "sleeping":
    case "timeout":
    case "too_many_frames":
    case "github_error":
    case "failed":
      return true;
    case "invalid":
    case "not_found":
    case "forbidden":
    case "limit":
    case "archived":
    case "deleting":
    case "conflict":
    case "onboarding_incomplete":
    case "not_configured":
    case "event_too_large":
    case "turn_failed":
      return false;
  }
}

/** Errors that mean the caller can never succeed with these credentials (the bridge stops retrying on these). */
export const isFatal = (err: AppError) => err.code === "forbidden";
