import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { toAppError } from "@dorks/shared";
import { createApi } from "./http.ts";
import { createClient, type DorksClient } from "./client.ts";
import { createSseParser } from "./live.ts";
import { startMockServer, type MockServer } from "./mock-server.ts";

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: MockServer;
let client: DorksClient | undefined;
const unsubs: (() => void)[] = [];
const watch = <T extends { subscribe(l: () => void): () => void }>(store: T): T => {
  unsubs.push(store.subscribe(() => {}));
  return store;
};

beforeEach(async () => {
  server = await startMockServer({ configured: true, tick: 15 });
});
afterEach(async () => {
  for (const u of unsubs.splice(0)) u();
  client?.close();
  client = undefined;
  await server.close();
});

const connect = (over: Partial<Parameters<typeof createClient>[0]> = {}) => {
  client = createClient({ baseUrl: server.url, token: server.token, pageSize: 40, retryDelay: () => 20, ...over });
  client.start();
  return client;
};

describe("sse parser", () => {
  it("joins chunks, handles CRLF, ignores comments", () => {
    const got: string[] = [];
    const feed = createSseParser((d) => got.push(d));
    feed('data: {"t":"hel');
    feed('lo"}\n\n: ping\n\ndata: {"t":"do');
    feed('rks"}\r\n\r\n');
    feed("data: a\ndata: b\n\n");
    expect(got).toEqual(['{"t":"hello"}', '{"t":"dorks"}', "a\nb"]);
  });
});

describe("live stream", () => {
  it("reconnects after a drop and refetches everything it shows", async () => {
    const c = connect();
    const dorks = watch(c.dorks(false));
    await waitFor(() => c.connectionStore.getSnapshot().live === "live" && dorks.getSnapshot().status === "ready", "live");
    server.dropLive();
    const { id } = await c.api.createDork({ repo: "acme/demo", message: "x" }); // the invalidation may fall in the gap; hello must recover it
    await waitFor(() => dorks.getSnapshot().data?.some((d) => d.id === id), "listed after reconnect");
    await waitFor(() => c.connectionStore.getSnapshot().live === "live", "live again");
  });
});

describe("live stream holders", () => {
  it("stays open while anyone holds it: one holder letting go never closes it under another", async () => {
    client = createClient({ baseUrl: server.url, token: server.token, pageSize: 40, retryDelay: () => 20 });
    const c = client;
    const place = c.start(); // the cloud place, watching the home server while it resolves
    const screen = c.start(); // the screen's DorksProvider, mounted before the place lets go
    place();
    place(); // a second release of the same hold changes nothing
    const dorks = watch(c.dorks(false));
    await waitFor(() => c.connectionStore.getSnapshot().live === "live" && dorks.getSnapshot().status === "ready", "live");
    const { id } = await c.api.createDork({ repo: "acme/demo", message: "x" }); // only the stream can tell the list about it
    await waitFor(() => dorks.getSnapshot().data?.some((d) => d.id === id), "listed through the live stream");
    screen();
    expect(c.connectionStore.getSnapshot().live).toBe("connecting"); // closed with the last holder, and says so
  });
});

describe("events feed", () => {
  const settled = (c: DorksClient, id: string) =>
    waitFor(() => {
      const s = c.events(id).getSnapshot();
      return !s.loading && s.view.state === "idle" && s.view;
    }, "transcript settled");

  it("tails a whole turn into the folded transcript, including a message that grows in place", async () => {
    const c = connect();
    const { id } = await c.actions.createDork({ repo: "acme/demo", message: "fix the bug", provider: "codex" });
    watch(c.events(id));
    const view = await settled(c, id);
    expect(view.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant", "turn"]);
    const a = view.blocks.at(-2);
    expect(a).toMatchObject({ kind: "assistant", streaming: false, final: true }); // named by the turn's finalMessageId
    expect((a as { text: string }).text).toContain("Done: fix the bug");
    expect(view.blocks[1]).toMatchObject({ kind: "assistant" });
    expect((view.blocks[1] as { final?: boolean }).final).toBeUndefined(); // a progress message stays work
    expect(view.blocks[2]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("re-reads a row rewritten in place (same seq)", async () => {
    const dork = await createIdleDork();
    const c = connect();
    watch(c.events(dork));
    await waitFor(() => !c.events(dork).getSnapshot().loading, "first page");
    const seq = server.append(dork, { type: "assistant_delta", messageId: "m-x", text: "abc" }).seq;
    await waitFor(
      () =>
        c
          .events(dork)
          .getSnapshot()
          .view.blocks.some((b) => b.kind === "assistant" && b.text === "abc"),
      "partial shown",
    );
    const earlier = c.events(dork).getSnapshot().view.blocks.slice(0, -1);
    server.rewrite(dork, seq, { text: "abcdef" });
    await waitFor(
      () =>
        c
          .events(dork)
          .getSnapshot()
          .view.blocks.some((b) => b.kind === "assistant" && b.text === "abcdef"),
      "grown in place",
    );
    expect(
      c
        .events(dork)
        .getSnapshot()
        .view.blocks.filter((b) => b.kind === "assistant" && b.id === "m-x"),
    ).toHaveLength(1);
    // Only the grown row is new: the blocks before it are the same objects.
    expect(earlier.every((b, n) => c.events(dork).getSnapshot().view.blocks[n] === b)).toBe(true);
  });

  it("keeps following the open chat while WebKit reports the focused window hidden", async () => {
    // The desktop shell's WebKit can go on saying `hidden` after its window shows again; the open chat froze until a reload (#229).
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    const before = g.document;
    g.document = { visibilityState: "hidden", hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
    try {
      const dork = await createIdleDork();
      const c = connect();
      const feed = watch(c.events(dork));
      await waitFor(() => !feed.getSnapshot().loading, "first page");
      server.append(dork, { type: "assistant_delta", messageId: "m-h", text: "still live" });
      await waitFor(() => feed.getSnapshot().view.blocks.some((b) => b.kind === "assistant" && b.text === "still live"), "followed while reported hidden", 1000);
    } finally {
      if (had) g.document = before;
      else delete g.document;
    }
  });

  it("pages older history in on demand", async () => {
    const dork = await createIdleDork();
    for (let i = 0; i < 120; i++) server.append(dork, { type: "user_message", text: `m${i}` });
    const c = connect();
    const feed = watch(c.events(dork));
    await waitFor(() => !feed.getSnapshot().loading, "first page");
    expect(feed.getSnapshot().canLoadMore).toBe(true);
    const first = feed.getSnapshot().view.blocks.length;
    expect(first).toBeLessThanOrEqual(40);
    for (let i = 0; i < 6 && feed.getSnapshot().canLoadMore; i++) {
      const shown = feed.getSnapshot().view.blocks;
      feed.loadMore();
      await waitFor(() => !feed.getSnapshot().loadingMore && feed.getSnapshot().view.blocks.length > shown.length, "older page");
      // An older page keeps every block already shown as the same object, so the thread redraws only what the page added.
      expect(feed.getSnapshot().view.blocks.slice(-shown.length)).toEqual(shown);
      expect(
        feed
          .getSnapshot()
          .view.blocks.slice(-shown.length)
          .every((b, n) => b === shown[n]),
      ).toBe(true);
    }
    expect(feed.getSnapshot().canLoadMore).toBe(false);
    const users = feed
      .getSnapshot()
      .view.blocks.filter((b) => b.kind === "user")
      .map((b) => (b as { text: string }).text);
    expect(users.filter((t) => /^m\d+$/.test(t))).toHaveLength(120);
    expect(new Set(feed.getSnapshot().view.blocks.map((b) => b.id)).size).toBe(feed.getSnapshot().view.blocks.length); // no duplicates
  });

  it("shows a sent message immediately, then swaps in the confirmed row without duplicating it", async () => {
    const dork = await createIdleDork();
    const c = connect();
    const feed = watch(c.events(dork));
    await waitFor(() => !feed.getSnapshot().loading, "first page");
    const before = feed.getSnapshot().view.blocks.length;
    const sending = c.actions.sendMessage(dork, "second task");
    expect(feed.getSnapshot().view.blocks.at(-1)).toMatchObject({ kind: "user", text: "second task" }); // optimistic, before the server answered
    await sending;
    await waitFor(() => feed.getSnapshot().view.state === "idle" && feed.getSnapshot().view.blocks.filter((b) => b.kind === "assistant").length === 2, "second turn done");
    const users = feed.getSnapshot().view.blocks.filter((b) => b.kind === "user");
    expect(users.map((b) => (b as { text: string }).text).filter((t) => t === "second task")).toHaveLength(1);
    expect(feed.getSnapshot().view.blocks.length).toBeGreaterThan(before);
  });

  it("removes the optimistic row and rethrows when the server refuses", async () => {
    const dork = await createIdleDork();
    await connectAndArchive(dork);
    const c = connect();
    const feed = watch(c.events(dork));
    await waitFor(() => !feed.getSnapshot().loading, "first page");
    const before = feed.getSnapshot().view.blocks.length;
    const err = await c.actions.sendMessage(dork, "too late").catch((e) => e);
    expect(toAppError(err).code).toBe("archived");
    expect(feed.getSnapshot().view.blocks).toHaveLength(before);
  });

  async function createIdleDork() {
    const api = createApi({ baseUrl: server.url, token: server.token });
    const { id } = await api.createDork({ repo: "acme/demo", message: "start", provider: "codex" });
    await waitFor(() => server.dorks.get(id)?.state === "idle", "first turn done");
    return id;
  }
  async function connectAndArchive(id: string) {
    await createApi({ baseUrl: server.url, token: server.token }).setArchived(id, true);
  }
});
