# Error taxonomy

One typed error, `AppError`, shared by the backend, the bridge and the UIs. Source: `packages/shared/src/errors.ts`.

It is a TypeScript discriminated union on `code` (a union where one field tells you which variant you have), so a `switch (err.code)` is checked for completeness by the compiler. Every variant has a `message` that is safe to show users; some add fields (e.g. `rate_limited.retryAfterMs`).

| Group | Codes |
|---|---|
| Caller mistakes | `invalid`, `not_found`, `forbidden`, `limit`, `rate_limited` |
| Wrong state | `archived`, `deleting`, `conflict`, `sleeping` |
| Setup needed | `onboarding_incomplete`, `not_configured` |
| Bridge limits | `too_many_frames`, `event_too_large` |
| Upstream / internal | `github_error`, `timeout`, `turn_failed`, `failed` |

## Where it travels

- **Request errors** (mutations, queries, actions): throw with `fail(code, message)` (`apps/convex/convex/lib/dispatch.ts`), which throws `ConvexError(AppError)`. Clients call `toAppError(e)` (also `errorCode` / `errorMessage` from `@dorks/convex/client`). Anything that is not an AppError becomes `failed` with a generic message, so internals never reach the UI.
- **Transcript errors**: the `error` event carries `error?: AppError` next to the old `message`. Build them with `errorEvent(appError)`. Events stored before this change have no `error`; they still parse and render from `message`.
- **Bridge**: `Transport.errorCode` returns an `AppErrorCode` (or undefined for network failures).

`isRetryable(err)` and `isFatal(err)` hold the retry policy in one place.

## Adding a code

Add a variant to `appError`, then the compiler points at `isRetryable` (and any `switch`) that needs a decision.
