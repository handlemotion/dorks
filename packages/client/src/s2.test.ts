import { expect, it } from "vite-plus/test";
import { StreamReader, type SequencedRecord } from "./s2.ts";

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
