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

- **Request errors** (UI API): server code throws with `fail(code, message)` (`apps/server/src/app.ts`). The UI listener answers `{"error": AppError}` with a matching HTTP status (the table is in `apps/server/src/http/ui.ts`, summarized in [architecture](architecture.md)). `@dorks/client` throws an `ApiError` whose `data` is the AppError, and `toAppError(e)` from `@dorks/shared` reads it back. Anything that is not an AppError becomes `failed` with a generic message, so internals never reach the UI.
- **Bridge rpc errors**: a failed rpc response carries `{"ok": false, "error": AppError}`, and `Transport.errorCode` returns its code.
- **Transcript errors**: the `error` event carries `error?: AppError` next to the old `message`. Build them with `errorEvent(appError)`. Events stored before this change have no `error`; they still parse and render from `message`.
`isRetryable(err)` and `isFatal(err)` hold the retry policy in one place.

## Adding a code

Add a variant to `appError`, then the compiler points at `isRetryable` (and any `switch`) that needs a decision.
