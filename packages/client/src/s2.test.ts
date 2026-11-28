import { expect, it } from "vite-plus/test";
import { Assembler, StreamReader, type SequencedRecord } from "./s2.ts";

// The cloud transcript's one guarantee: whatever drops, the app sees every event once, in order, big ones whole.
it("reads a session's events across dropped connections: each once, in order, resends skipped, parts joined", async () => {
  const records: SequencedRecord[] = [];
  const add = (headers: [string, string][], body: string) => records.push({ seq_num: records.length, timestamp: 0, headers, body });
  const ev = (b: number) =>
    add(
      [
        ["k", "ev"],
        ["b", String(b)],
        ["c", "0"],
      ],
      `e${b}`,
    );
  const part = (b: number, i: number, body: string) =>
    add(
      [
        ["k", "part"],
        ["b", String(b)],
        ["c", "0"],
        ["p", `${i}/3`],
      ],
      body,
    );
  add([["", "fence"]], "f"); // written by s2 itself: skipped
  for (let b = 1; b <= 20; b++) ev(b);
  ev(19); // a restarted bridge resending what was already written
  ev(20);
  part(21, 0, "A"); // the bridge crashed after the first part, then resent the event whole
  part(21, 0, "A");
  part(21, 1, "B");
  part(21, 2, "C");
  ev(22);

  const enc = new TextEncoder();
  const starts: number[] = [];
  // Each connection serves at most 4 records from where the reader asked, then the network drops.
  const fake = (async (url: string) => {
    const from = Number(/seq_num=(\d+)/.exec(url)![1]);
    starts.push(from);
    const batch = records.slice(from, from + 4);
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        const r = batch[i++];
        if (r) c.enqueue(enc.encode(`event: batch\ndata: ${JSON.stringify({ records: [r] })}\n\n`));
        else c.error(new TypeError("network drop"));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const reader = new StreamReader({ fetch: fake, grant: async () => ({ token: "t", url: "https://b.s2.dev/v1/streams/s/records", expiresAt: Date.now() + 600_000 }) });
  const got: string[] = [];
  for await (const item of reader.items()) {
    got.push(item.body);
    if (got.length === 22) break;
  }
  expect(got).toEqual([...Array.from({ length: 20 }, (_, i) => `e${i + 1}`), "ABC", "e22"]);
  expect(starts).toEqual([0, 4, 8, 12, 16, 20, 24]); // each reconnect resumes right after the last record read
});

it("opens a read again when it goes silent (no record, no ping), resuming after the last record", async () => {
  const enc = new TextEncoder();
  const starts: number[] = [];
  // The first connection delivers one record and then hangs forever (a half-open connection); the second delivers the next one.
  const fake = (async (url: string, init?: RequestInit) => {
    const from = Number(/seq_num=(\d+)/.exec(url)![1]);
    starts.push(from);
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(
          enc.encode(
            `event: batch\ndata: ${JSON.stringify({
              records: [
                {
                  seq_num: from,
                  timestamp: 0,
                  headers: [
                    ["k", "ev"],
                    ["b", String(from + 1)],
                    ["c", "0"],
                  ],
                  body: `e${from}`,
                },
              ],
            })}\n\n`,
          ),
        );
        init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const reader = new StreamReader({ fetch: fake, idleMs: 50, grant: async () => ({ token: "t", url: "https://b.s2.dev/v1/streams/s/records", expiresAt: Date.now() + 600_000 }) });
  const got: string[] = [];
  for await (const item of reader.items()) {
    got.push(item.body);
    if (got.length === 2) break;
  }
  expect(got).toEqual(["e0", "e1"]);
  expect(starts).toEqual([0, 1]);
});

it("never lets a reader resume past an event whose parts are still arriving", () => {
  const a = new Assembler();
  a.push({
    seq_num: 0,
    timestamp: 0,
    headers: [
      ["k", "ev"],
      ["b", "1"],
      ["c", "0"],
    ],
    body: "e1",
  });
  a.push({
    seq_num: 1,
    timestamp: 0,
    headers: [
      ["k", "part"],
      ["b", "2"],
      ["c", "0"],
      ["p", "0/2"],
    ],
    body: "A",
  });
  expect(a.safeSeq).toBe(0);
  a.push({
    seq_num: 2,
    timestamp: 0,
    headers: [
      ["k", "part"],
      ["b", "2"],
      ["c", "0"],
      ["p", "1/2"],
    ],
    body: "B",
  });
  expect(a.safeSeq).toBe(2);
});
