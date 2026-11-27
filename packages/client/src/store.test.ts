import { describe, expect, it } from "vite-plus/test";
import { Query } from "./store.ts";

/** A Query whose reads the test answers one by one. */
function controlled() {
  const pending: ((v: string[]) => void)[] = [];
  const q = new Query<string[]>(() => new Promise((r) => pending.push(r)), { retryDelay: () => 10, onUnauthorized: () => {} });
  const answer = async (v: string[]) => {
    pending.shift()!(v);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { q, answer, pending };
}

describe("optimistic writes", () => {
  it("survive a read that started before the server confirmed them, and give way to one that started after", async () => {
    const { q, answer, pending } = controlled();
    q.subscribe(() => {});
    await answer(["a", "b"]);
    const w = q.optimistic((rows) => rows.filter((r) => r !== "a")); // archive "a"
    expect(q.getSnapshot().data).toEqual(["b"]);
    q.invalidate(); // a live invalidation: this read may have been served before the write
    w.settle();
    await answer(["a", "b"]);
    expect(q.getSnapshot().data).toEqual(["b"]); // the stale read does not bring the row back
    q.invalidate(); // the client's own read after the write
    await answer(["b", "c"]);
    expect(q.getSnapshot().data).toEqual(["b", "c"]);
    q.invalidate();
    await answer(["a", "c"]); // restored elsewhere later: the patch is gone, the server's data shows as is
    expect(q.getSnapshot().data).toEqual(["a", "c"]);
    expect(pending).toHaveLength(0);
  });

  it("are taken back when the server refuses them", async () => {
    const { q, answer } = controlled();
    q.subscribe(() => {});
    await answer(["a"]);
    const w = q.optimistic(() => []);
    expect(q.getSnapshot().data).toEqual([]);
    w.rollback();
    expect(q.getSnapshot().data).toEqual(["a"]);
  });

  it("with `until`, stay past newer reads until the server's data has the change", async () => {
    const { q, answer } = controlled();
    q.subscribe(() => {});
    await answer(["open"]);
    const w = q.optimistic(
      () => ["merged"],
      (rows) => rows[0] !== "open",
    );
    w.settle();
    q.invalidate();
    await answer(["open"]); // the poller has not seen the merge yet
    expect(q.getSnapshot().data).toEqual(["merged"]);
    q.invalidate();
    await answer(["merged"]);
    q.invalidate();
    await answer(["open"]); // dropped once recorded: a later change shows
    expect(q.getSnapshot().data).toEqual(["open"]);
  });
});
