import { describe, expect, it } from "vite-plus/test";
import { toAppError, UNKNOWN_ERROR_MESSAGE } from "./errors";
import { clientEvent, errorEvent } from "./events";
import { emptyView, fold } from "./client/fold";

describe("toAppError", () => {
  it("reads an AppError payload from `data`", () => {
    expect(toAppError({ data: { code: "limit", message: "at most 3" } })).toEqual({ code: "limit", message: "at most 3" });
  });
  it("downgrades unknown codes to `failed`, keeping a safe message", () => {
    expect(toAppError({ data: { code: "brand_new", message: "hi" } })).toEqual({ code: "failed", message: "hi" });
  });
  it("never leaks a plain Error's message", () => {
    expect(toAppError(new Error("secret stack detail"))).toEqual({ code: "failed", message: UNKNOWN_ERROR_MESSAGE });
    expect(toAppError(undefined)).toEqual({ code: "failed", message: UNKNOWN_ERROR_MESSAGE });
  });
});

describe("error events", () => {
  it("round-trips through the client event schema and folds to a notice", () => {
    const e = { ...errorEvent({ code: "timeout", message: "timed out" }), seq: 1, dorkId: "d", ts: 0 };
    expect(clientEvent.parse(e)).toEqual(e);
    expect(fold(emptyView(), clientEvent.parse(e)).blocks).toEqual([{ kind: "notice", id: "n1", level: "error", text: "timed out" }]);
  });
});
