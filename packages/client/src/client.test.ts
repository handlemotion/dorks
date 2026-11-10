import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toAppError } from "@dorks/shared";
import { ApiError, createApi } from "./http.ts";
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

describe("http api", () => {
  it("maps server errors to ApiError whose data toAppError reads", async () => {
    const api = createApi({ baseUrl: server.url, token: server.token });
    const e = await api.createDork({ repo: "nope", message: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(toAppError(e)).toEqual({ code: "invalid", message: "repo must look like owner/name" });
  });

  it("reports a wrong token as forbidden and an unreachable server as failed", async () => {
    const bad = createApi({ baseUrl: server.url, token: "wrong" });
    expect(toAppError(await bad.listDorks().catch((x) => x)).code).toBe("forbidden");
    await server.close();
    const down = createApi({ baseUrl: server.url, token: server.token });
    expect(await down.health()).toBe(false);
    const e = await down.listDorks().catch((x) => x);
    expect(e.status).toBe(0);
    expect(toAppError(e).code).toBe("failed");
    server = await startMockServer({ configured: true }); // for afterEach
  });
});

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

describe("queries", () => {
  it("loads the dork list and refetches when the server says it changed", async () => {
    const c = connect();
    const dorks = watch(c.dorks(false));
    await waitFor(() => dorks.getSnapshot().status === "ready", "first load");
    expect(dorks.getSnapshot().data).toEqual([]);
    const { id } = await c.actions.createDork({ repo: "acme/demo", message: "hello", provider: "codex" });
    const row = await waitFor(() => dorks.getSnapshot().data?.find((d) => d.id === id), "new dork listed");
    expect(row.repo).toBe("acme/demo");
    await waitFor(() => dorks.getSnapshot().data?.find((d) => d.id === id)?.state === "idle", "turn finished and state followed over the live stream");
  });

  it("returns null for a dork that does not exist instead of an error", async () => {
    const c = connect();
    const one = watch(c.dork("11111111-1111-1111-1111-111111111111"));
    const s = await waitFor(() => one.getSnapshot().status === "ready" && one.getSnapshot(), "loaded");
    expect(s.data).toBeNull();
  });

  it("retries a failed read and recovers", async () => {
    const c = connect();
    const settings = watch(c.settings());
    await waitFor(() => settings.getSnapshot().status === "ready", "loaded");
    const port = Number(new URL(server.url).port);
    const data = server.settings;
    await server.close();
    server = await startMockServer({ configured: true, port });
    Object.assign(server.settings, data, { sleepMinutes: 42 });
    await waitFor(() => settings.getSnapshot().data?.sleepMinutes === 42, "refetched after the server came back");
  });

  it("flags a rejected token and stops retrying", async () => {
    const c = connect({ token: "wrong" });
    await waitFor(() => c.connectionStore.getSnapshot().unauthorized, "unauthorized");
    const q = watch(c.dorks(false));
    await waitFor(() => q.getSnapshot().status === "error", "errored");
    expect(q.getSnapshot().error?.code).toBe("forbidden");
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

describe("events feed", () => {
  const settled = (c: DorksClient, id: string) => waitFor(() => {
    const s = c.events(id).getSnapshot();
    return !s.loading && s.view.state === "idle" && s.view;
  }, "transcript settled");

  it("tails a whole turn into the folded transcript, including a message that grows in place", async () => {
    const c = connect();
    const { id } = await c.actions.createDork({ repo: "acme/demo", message: "fix the bug", provider: "codex" });
    watch(c.events(id));
    const view = await settled(c, id);
    expect(view.blocks.map((b) => b.kind)).toEqual(["user", "tool", "assistant"]);
    const a = view.blocks.at(-1);
    expect(a).toMatchObject({ kind: "assistant", streaming: false });
    expect((a as { text: string }).text).toContain("Done: fix the bug");
    expect(view.blocks[1]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("re-reads a row rewritten in place (same seq)", async () => {
    const dork = await createIdleDork();
    const c = connect();
    watch(c.events(dork));
    await waitFor(() => !c.events(dork).getSnapshot().loading, "first page");
    const seq = server.append(dork, { type: "assistant_delta", messageId: "m-x", text: "abc" }).seq;
    await waitFor(() => c.events(dork).getSnapshot().view.blocks.some((b) => b.kind === "assistant" && b.text === "abc"), "partial shown");
    server.rewrite(dork, seq, { text: "abcdef" });
    await waitFor(() => c.events(dork).getSnapshot().view.blocks.some((b) => b.kind === "assistant" && b.text === "abcdef"), "grown in place");
    expect(c.events(dork).getSnapshot().view.blocks.filter((b) => b.kind === "assistant" && b.id === "m-x")).toHaveLength(1);
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
      const before = feed.getSnapshot().view.blocks.length;
      feed.loadMore();
      await waitFor(() => !feed.getSnapshot().loadingMore && feed.getSnapshot().view.blocks.length > before, "older page");
    }
    expect(feed.getSnapshot().canLoadMore).toBe(false);
    const users = feed.getSnapshot().view.blocks.filter((b) => b.kind === "user").map((b) => (b as { text: string }).text);
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
