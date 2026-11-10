import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES, appError, isAppError, isFatal, isRetryable, toAppError, UNKNOWN_ERROR_MESSAGE } from "./errors";
import { clientEvent, errorEvent } from "./events";
import { emptyView, fold } from "./client/fold";

describe("toAppError", () => {
  it("reads an AppError payload from `data`", () => {
    expect(toAppError({ data: { code: "limit", message: "at most 3" } })).toEqual({ code: "limit", message: "at most 3" });
  });
  it("keeps variant-specific fields", () => {
    expect(toAppError({ data: { code: "rate_limited", message: "slow down", retryAfterMs: 5000 } })).toEqual({ code: "rate_limited", message: "slow down", retryAfterMs: 5000 });
  });
  it("downgrades unknown codes to `failed`, keeping a safe message", () => {
    expect(toAppError({ data: { code: "brand_new", message: "hi" } })).toEqual({ code: "failed", message: "hi" });
  });
  it("never leaks a plain Error's message", () => {
    expect(toAppError(new Error("secret stack detail"))).toEqual({ code: "failed", message: UNKNOWN_ERROR_MESSAGE });
    expect(toAppError(undefined)).toEqual({ code: "failed", message: UNKNOWN_ERROR_MESSAGE });
  });
});

describe("taxonomy", () => {
  it("every code parses and is classified", () => {
    for (const code of APP_ERROR_CODES) {
      const e = { code, message: "m" };
      expect(isAppError(e)).toBe(true);
      expect(typeof isRetryable(appError.parse(e))).toBe("boolean");
    }
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
  });
  it("classifies retryability and fatality", () => {
    expect(isRetryable({ code: "sleeping", message: "" })).toBe(true);
    expect(isRetryable({ code: "invalid", message: "" })).toBe(false);
    expect(isFatal({ code: "forbidden", message: "" })).toBe(true);
    expect(isFatal({ code: "sleeping", message: "" })).toBe(false);
  });
});

describe("error events", () => {
  it("round-trips through the client event schema and folds to a notice", () => {
    const e = { ...errorEvent({ code: "timeout", message: "timed out" }), seq: 1, dorkId: "d", ts: 0 };
    expect(clientEvent.parse(e)).toEqual(e);
    expect(fold(emptyView(), clientEvent.parse(e)).blocks).toEqual([{ kind: "notice", id: "n1", level: "error", text: "timed out" }]);
  });
  it("still accepts legacy stored events without `error`", () => {
    expect(clientEvent.safeParse({ type: "error", message: "old", seq: 1, dorkId: "d", ts: 0 }).success).toBe(true);
  });
});
