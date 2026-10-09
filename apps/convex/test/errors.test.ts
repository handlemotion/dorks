import { ConvexError } from "convex/values";
import { toAppError } from "@dorks/shared";
import { describe, expect, it } from "vitest";
import { fail } from "../convex/lib/dispatch";

describe("fail", () => {
  it("throws a ConvexError whose payload is a typed AppError", () => {
    let caught: unknown;
    try {
      fail("limit", "at most 3");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect(toAppError(caught)).toEqual({ code: "limit", message: "at most 3" });
  });
});
