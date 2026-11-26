// Reading a Dorks Cloud org's streams straight from s2.dev (docs/architecture.md, "Live updates for cloud orgs"). Ported from
// handlemotion/dorks-cloud `src/realtime/reader.ts` and `records.ts` (the reference for this adapter; keep the record layout in step):
// SSE from `seq_num = last seen + 1` with a short-lived read-only token, reconnecting after any drop, before the token expires and at
// least every `maxConnectionMs` with a fresh grant, so nothing is lost or repeated. Runtime-neutral: fetch + ReadableStream only.
//
// Records of a session's `events` stream carry headers `k` ("ev" one event, "part" a slice of a big one, "cmd" a command echo),
// `b` (the bridge's sequence number, its dedupe key), `c` (its command cursor) and, for parts, `p` = "<i>/<n>". Bodies are UTF-8
// JSON. Records s2 writes itself (fence, trim) are command records: one header with an empty name.

export type SequencedRecord = { seq_num: number; timestamp: number; headers?: [string, string][]; body?: string };
type ReadBatch = { records: SequencedRecord[] };

/** A non-2xx answer from s2. */
export class S2Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Worth retrying with backoff (https://s2.dev/docs/api/error-codes). */
  get retryable() {
    return this.status === 408 || this.status === 429 || this.status >= 500 || this.code === "transaction_conflict";
  }
  /** The token is unknown, expired or revoked (401), or lacks the scope (403). */
  get unauthorized() {
    return this.status === 401 || (this.status === 403 && this.code === "permission_denied");
  }
}

const isCommandRecord = (r: SequencedRecord) => r.headers?.length === 1 && r.headers[0]![0] === "";
const header = (r: SequencedRecord, name: string) => r.headers?.find(([k]) => k === name)?.[1];

export type SessionItem = { kind: "event"; seq: number; bseq: number; body: string; timestamp: number } | { kind: "command"; seq: number; cid: string; body: string; timestamp: number };

/** A record of an org live stream (the feed), as `raw` readers yield it. */
export type RawItem = { kind: "record"; seq: number; timestamp: number; body: string };

/**
 * Turns records (in stream order, possibly re-read after a reconnect) into whole events and command echoes, exactly once each:
 * records at or below the last seq_num are ignored, events at or below the last bseq are ignored (a bridge that resent after a
 * crash), parts are joined, and a part sequence restarted from 0 replaces the partial one.
 */
export class Assembler {
  lastSeq = -1;
  lastBseq = 0;
  private parts: { bseq: number; n: number; got: string[]; seq: number } | null = null;

  /** The last seq_num a new reader may resume after without losing anything: before an event whose parts are still arriving. */
  get safeSeq() {
    return this.parts ? this.parts.seq - 1 : this.lastSeq;
  }

  push(r: SequencedRecord): SessionItem[] {
    if (r.seq_num <= this.lastSeq) return [];
    this.lastSeq = r.seq_num;
    if (isCommandRecord(r)) return [];
    const k = header(r, "k");
    const b = Number(header(r, "b") ?? NaN);
    if (k === "cmd") return [{ kind: "command", seq: r.seq_num, cid: header(r, "id") ?? "", body: r.body ?? "", timestamp: r.timestamp }];
    if (!Number.isFinite(b) || b <= this.lastBseq) return [];
    if (k === "ev") {
      this.parts = null;
      return [this.event(r, b, r.body ?? "")];
    }
    return k === "part" ? this.part(r, b) : [];
  }

  private event(r: SequencedRecord, bseq: number, body: string): SessionItem {
    this.lastBseq = bseq;
    return { kind: "event", seq: r.seq_num, bseq, body, timestamp: r.timestamp };
  }

  private part(r: SequencedRecord, b: number): SessionItem[] {
    const [i, n] = (header(r, "p") ?? "").split("/").map(Number) as [number, number];
    if (i === 0 || !this.parts || this.parts.bseq !== b) this.parts = i === 0 ? { bseq: b, n, got: [], seq: r.seq_num } : null;
    if (!this.parts || this.parts.got.length !== i) return []; // a gap: wait for the resend from part 0
    this.parts.got.push(r.body ?? "");
    if (this.parts.got.length < n) return [];
    const body = this.parts.got.join("");
    this.parts = null;
    return [this.event(r, b, body)];
  }
}

/** What the Worker's token routes return: a read-only token for one stream, its records URL, and the stream's aegis-256 key. */
export type ReadGrant = { token: string; url: string; expiresAt: number; encryptionKey?: string | null };

export interface ReaderOptions {
  /** Asks the Worker for a (new) read token: at start, before expiry, at least every `maxConnectionMs`, after s2 refuses one. */
  grant: () => Promise<ReadGrant>;
  /** Resume after this seq_num; -1 = from the start. */
  afterSeq?: number;
  /** Skip events at or below this bridge seq (carried over from an earlier reader of the same stream). */
  afterBseq?: number;
  /** Reconnect this long before the token expires (s2 does not cut an open read at expiry). Default 30 s. */
  refreshBeforeMs?: number;
  /** Reconnect with a fresh grant at least this often (default 10 min), so the Worker re-checks membership. */
  maxConnectionMs?: number;
  /** Yield raw records (the org feed) instead of assembling session events. */
  raw?: boolean;
  /** For a first connection without `afterSeq`: start at this timestamp (ms). */
  fromTimestamp?: number;
  /** Each time a read is open (the first, and after every reconnect). */
  onConnect?: () => void;
  fetch?: typeof fetch;
}

const authHeaders = (g: ReadGrant): Record<string, string> => ({
  authorization: `Bearer ${g.token}`,
  ...(g.encryptionKey ? { "s2-encryption-key": g.encryptionKey } : {}),
});

async function s2Error(res: Response, what: string) {
  const body = (await res.json().catch(() => ({}))) as { code?: string } | null;
  const code = body?.code ?? `http_${res.status}`;
  return new S2Error(res.status, code, `s2 ${what}: ${res.status} ${code}`);
}

/** The stream's next seq_num (check-tail; the read token allows it). */
export async function checkTail(grant: ReadGrant, f: typeof fetch = fetch): Promise<number> {
  const res = await f(`${grant.url}/tail`, { headers: authHeaders(grant) });
  if (!res.ok) throw await s2Error(res, "check-tail");
  return ((await res.json()) as { tail: { seq_num: number } }).tail.seq_num;
}

/** Follows one stream over SSE (`items()`), resuming from the last seq_num after any disconnect. */
export class StreamReader {
  private readonly opts: ReaderOptions;
  readonly assembler = new Assembler();
  private conn: AbortController | null = null;
  stats = { connections: 0, grants: 0, refused: 0 };

  constructor(opts: ReaderOptions) {
    this.opts = opts;
    this.assembler.lastSeq = opts.afterSeq ?? -1;
    this.assembler.lastBseq = opts.afterBseq ?? 0;
  }

  get lastSeq() {
    return this.assembler.lastSeq;
  }

  /** Drops the current connection as a network failure would; `items()` reconnects from the last seq_num. */
  dropConnection() {
    this.conn?.abort(new Error("dropped"));
  }

  private raw(r: SequencedRecord): RawItem | null {
    if (r.seq_num <= this.assembler.lastSeq) return null;
    this.assembler.lastSeq = r.seq_num;
    if (isCommandRecord(r)) return null;
    return { kind: "record", seq: r.seq_num, timestamp: r.timestamp, body: r.body ?? "" };
  }

  async *items(signal?: AbortSignal): AsyncGenerator<SessionItem | RawItem> {
    const f = this.opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const refreshBefore = this.opts.refreshBeforeMs ?? 30_000;
    const maxConn = this.opts.maxConnectionMs ?? 10 * 60_000;
    let grant: ReadGrant | null = null;
    while (!signal?.aborted) {
      if (!grant || grant.expiresAt - Date.now() < refreshBefore) {
        grant = await this.opts.grant();
        this.stats.grants++;
        if (signal?.aborted) return; // stopped while the grant was on its way: open nothing
      }
      const conn = (this.conn = new AbortController());
      const onAbort = () => conn.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort);
      const untilRefresh = grant.expiresAt - Date.now() - refreshBefore;
      const timer = setTimeout(
        () => {
          if (maxConn <= untilRefresh) grant = null; // the connection is old enough: ask the Worker again
          conn.abort(new Error("reconnect"));
        },
        Math.max(1000, Math.min(untilRefresh, maxConn)),
      );
      try {
        yield* this.read(f, grant, conn.signal);
      } catch (e) {
        if (signal?.aborted) return;
        const next = this.recover(e, conn.signal.aborted);
        if (next.regrant) grant = null; // expired or revoked: ask the Worker again (it refuses one if we are no longer a member)
        if (next.waitMs) await new Promise((r) => setTimeout(r, next.waitMs));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  private failures = 0;

  /** One SSE read from the last seq_num, until s2 ends it or it is aborted (dropped, refreshing, closed). */
  private async *read(f: typeof fetch, grant: ReadGrant, signal: AbortSignal): AsyncGenerator<SessionItem | RawItem> {
    const start = this.assembler.lastSeq < 0 && this.opts.fromTimestamp !== undefined ? `timestamp=${this.opts.fromTimestamp}` : `seq_num=${this.assembler.lastSeq + 1}`;
    const res = await f(`${grant.url}?${start}&clamp=true`, { headers: { ...authHeaders(grant), accept: "text/event-stream", "s2-format": "raw" }, signal });
    if (!res.ok || !res.body) throw await s2Error(res, "read");
    this.stats.connections++;
    this.failures = 0;
    this.opts.onConnect?.();
    for await (const ev of sse(res.body)) {
      if (signal.aborted) return;
      if (ev.event === "error") throw new Error(`s2 read session error: ${ev.data}`);
      if (ev.event === "batch") yield* this.records((JSON.parse(ev.data) as ReadBatch).records);
    }
  }

  private *records(records: SequencedRecord[]): Generator<SessionItem | RawItem> {
    for (const r of records) {
      if (!this.opts.raw) yield* this.assembler.push(r);
      else {
        const item = this.raw(r);
        if (item) yield item;
      }
    }
  }

  /** After a read failed: whether to ask for a new grant, and how long to wait first. Throws when retrying cannot help. */
  private recover(e: unknown, dropped: boolean): { regrant: boolean; waitMs: number } {
    if (e instanceof S2Error && e.unauthorized) {
      this.stats.refused++;
      if (this.failures++ > 3) throw e;
      return { regrant: true, waitMs: 0 };
    }
    if (e instanceof S2Error && !e.retryable) throw e;
    if (dropped) return { regrant: false, waitMs: 0 }; // dropped or refreshing: reconnect at once
    return { regrant: false, waitMs: Math.min(10_000, 250 * 2 ** this.failures++) };
  }
}

/** A minimal text/event-stream parser (event + data lines). */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  } finally {
    reader.releaseLock();
    body.cancel().catch(() => {});
  }
}
