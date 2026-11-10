import { describe, expect, it, vi } from "vitest";
import { parentPid, pidAlive, watchParent } from "../src/parentWatch";

describe("parent watch", () => {
  it("reads a usable pid only", () => {
    expect(parentPid({ DORKS_PARENT_PID: "4242" })).toBe(4242);
    for (const bad of [undefined, "", "abc", "-5", "1", "0", "12.5", "99999999999999999999"]) expect(parentPid({ DORKS_PARENT_PID: bad })).toBeUndefined();
  });

  it("knows a live pid from a dead one", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(1, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); })).toBe(true);
    expect(pidAlive(999_999, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); })).toBe(false);
  });

  it("fires once when the parent disappears, and not before", () => {
    vi.useFakeTimers();
    let alive = true;
    const gone = vi.fn();
    watchParent(123, gone, 1000, () => alive);
    vi.advanceTimersByTime(3000);
    expect(gone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(5000);
    expect(gone).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
