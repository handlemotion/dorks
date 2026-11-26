// The bridge's writer for a session's s2 streams. Ported from handlemotion/dorks-cloud src/realtime @ df775f3 (bridge.ts, BridgeWriter), which
// docs/realtime.md there describes; the changes are marked "bridge:".
//
// Exactly-once appends: the Worker fenced the events stream with this bridge's token (connect), and the writer is then the stream's
// only writer. Every batch carries that fencing token (a replaced or zombie bridge gets 412 and stops: FencedError) and
// match_seq_num = the seq_num it expects to land at. A retry after a lost acknowledgement either lands at the same position or gets
// 412 seq_num_mismatch; the writer then reads the records at that position and, if they are its own batch, takes the earlier
// attempt as the success. So a retry never writes twice, and nothing written is skipped.
//
// Commands, at least once and deduplicated: the bridge acks a command once the agent has it; ack() appends its echo ("cmd" record)
// to events, in order with the agent's output. bridge: commands may be acked out of order (a message waits for the agent while the
// configure after it is done), so every record carries the cursor (`c`, the first unacked seq_num) and the cids acked past it (`a`).
// A bridge that crashes between delivery and ack has not acked, so its successor delivers that command again (never lost). The
// Worker may append the same cid twice (a retried client or fetch): the tail skips a cid delivered in this process, acked past
// the cursor, or seen in the last COMMAND_DEDUPE_WINDOW command records before it.

import { encodeCommandEcho, encodeEvent, encodeNote, header, MAX_ACKED_AHEAD, meteredBytes, packBatches, resumeFrom, type BridgeEvent, type Command, type Cursor } from "./records";
import { isCommandRecord, S2, S2Error, type AppendRecord, type SequencedRecord } from "./s2";

export const COMMAND_DEDUPE_WINDOW = 256;

export class FencedError extends Error {
  constructor(actual: unknown) {
    super(`this bridge was replaced: the events stream is fenced with another token (${String(actual)})`);
  }
}
export class ConflictError extends Error {}

type Pending = { records: AppendRecord[]; done: number; resolve: () => void; reject: (e: unknown) => void };

export type BridgeWriterOptions = {
  /** An S2 client holding the bridge's token (append, read, check-tail on the session's prefix) and the session's key. */
  s2: S2;
  streams: { events: string; commands: string };
  /** The fencing token the Worker set (connect). */
  fence: string;
  /** Called when s2 refuses the token (expired): returns a fresh bridge token from the Worker. */
  refreshToken?: () => Promise<string>;
  /** Backpressure: append() waits while more than this many bytes are queued. Default 16 MiB. */
  maxQueueBytes?: number;
  /** Give up on a batch after this many failed attempts (transient errors back off up to 5 s). Default 40. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BridgeWriter {
  private s2: S2;
  private readonly opts: BridgeWriterOptions;
  /** The seq_num the next batch must land at. */
  nextSeq = 0;
  /** The last bseq durably written. */
  lastBseq = 0;
  /** The first commands seq_num not acked yet: a restarted bridge reads from here. */
  cursor = 0;
  /** bridge: acked commands at or after the cursor, by seq_num. */
  private ackedAhead = new Map<number, string>();
  /** bridge: delivered and not acked yet, by seq_num. */
  private unacked = new Map<number, Command>();
  /** bridge: the next commands seq_num the tail reads. */
  private readPos = 0;
  private lastQueuedBseq = 0;
  private queue: Pending[] = [];
  private queuedBytes = 0;
  private flushing: Promise<void> | null = null;
  private drained: (() => void)[] = [];
  private failed: unknown = null;
  /** Stats for tests and logs. */
  stats = { batches: 0, retries: 0, dedupedRetries: 0, duplicatesSkipped: 0 };

  private constructor(opts: BridgeWriterOptions) {
    this.opts = opts;
    this.s2 = opts.s2;
  }

  /** Finds where this session's events stand: the tail, the last bseq written and the command cursor. */
  static async open(opts: BridgeWriterOptions) {
    const w = new BridgeWriter(opts);
    await w.withAuth(async () => {
      const tail = await w.s2.checkTail(opts.streams.events);
      w.nextSeq = tail.seq_num;
      // Walk back from the tail to the last data record (fence records and the tail itself carry nothing).
      for (let k = 8; tail.seq_num > 0; k *= 8) {
        const { records } = await w.s2.read(opts.streams.events, { tailOffset: Math.min(k, tail.seq_num) }, { count: Math.min(k, 1000) });
        for (let i = records.length - 1; i >= 0; i--) {
          const r = resumeFrom(records[i]);
          if (r) {
            w.lastBseq = w.lastQueuedBseq = r.lastBseq;
            w.cursor = r.cursor;
            return void w.seedAckedAhead(r.ackedAhead);
          }
        }
        if (k >= tail.seq_num || k >= 1000) break; // only command records near the tail (fresh stream, or many fences)
      }
    });
    w.readPos = w.cursor;
    return w;
  }

  /** bridge: the `a` header names cids, not seq_nums; they are matched when the tail reads them again. */
  private resumedAhead = new Set<string>();
  private seedAckedAhead(cids: string[]) {
    for (const c of cids) this.resumedAhead.add(c);
  }

  /** The broken writer's error, once it has failed for good (fenced, conflict, out of attempts). */
  get error() {
    return this.failed;
  }

  /** bridge: a fresh token for the same streams (the Worker renews it before it expires). */
  setToken(token: string) {
    this.s2 = this.s2.withToken(token);
  }

  /** Queues events (bseq strictly increasing; ones at or below what is queued are dropped as resends). Resolves once durable. */
  append(events: BridgeEvent[]): Promise<void> {
    const records: AppendRecord[] = [];
    for (const ev of events) {
      if (ev.bseq <= this.lastQueuedBseq) continue;
      records.push(...encodeEvent(ev, this.cursorNow()));
      this.lastQueuedBseq = ev.bseq;
    }
    return this.enqueue(records);
  }

  /** bridge: client events the bridge adds itself (a "note" record). Resolves once durable. */
  note(body: string): Promise<void> {
    return this.enqueue([encodeNote(body, this.lastQueuedBseq, this.cursorNow())]);
  }

  /**
   * Acks a delivered command: queues its echo (or, bridge: `ret`, the answer to a call), which moves the cursor past it. Call it
   * once the agent has the command and before appending the agent's output for it. Resolves once durable; after that the command
   * is never redelivered. Acking a command twice, or one this writer never delivered, is a no-op.
   */
  ack(cmd: Command, ret?: string): Promise<void> {
    if (!this.unacked.delete(cmd.seq)) return Promise.resolve();
    this.ackedAhead.set(cmd.seq, cmd.cid);
    this.advanceCursor();
    return this.enqueue([encodeCommandEcho(cmd, this.lastQueuedBseq, this.cursorNow(), ret)]);
  }

  /** The cursor moves to the first delivered-but-unacked command, or past everything read when all are acked. */
  private advanceCursor() {
    const firstUnacked = Math.min(...this.unacked.keys());
    this.cursor = Number.isFinite(firstUnacked) ? firstUnacked : this.readPos;
    for (const seq of this.ackedAhead.keys()) if (seq < this.cursor) this.ackedAhead.delete(seq);
  }

  private cursorNow(): Cursor {
    const ackedAhead = [...this.ackedAhead.values(), ...this.resumedAhead].slice(-MAX_ACKED_AHEAD);
    return { cursor: this.cursor, ackedAhead };
  }

  /** Waits until everything queued is durable. */
  flush(): Promise<void> {
    if (!this.queue.length) return this.failed ? Promise.reject(this.failed) : Promise.resolve();
    return new Promise<void>((resolve) => this.drained.push(resolve)).then(() => {
      if (this.failed) throw this.failed;
    });
  }

  private async enqueue(records: AppendRecord[]) {
    if (this.failed) throw this.failed;
    if (!records.length) return;
    const max = this.opts.maxQueueBytes ?? 16 * 1024 * 1024;
    while (this.queuedBytes > max && !this.failed) await this.flushOnce();
    const bytes = records.reduce((n, r) => n + meteredBytes(r), 0);
    this.queuedBytes += bytes;
    const p = new Promise<void>((resolve, reject) => this.queue.push({ records, done: 0, resolve, reject }));
    this.kick();
    return p;
  }

  private kick() {
    if (this.flushing) return;
    this.flushing = (async () => {
      while (this.queue.length && !this.failed) await this.flushOnce();
      this.flushing = null;
      for (const d of this.drained.splice(0)) d();
    })();
  }

  private flushOnce(): Promise<void> {
    // One batch from the head of the queue (an item may span batches; it resolves when its last record is durable).
    const flat: { item: Pending; rec: AppendRecord }[] = [];
    for (const item of this.queue) for (const rec of item.records.slice(item.done)) flat.push({ item, rec });
    const batch = packBatches(flat.map((f) => f.rec))[0];
    const owners = flat.slice(0, batch.length);
    return this.appendBatch(batch).then(
      () => {
        this.stats.batches++;
        for (const { item, rec } of owners) {
          item.done++;
          this.queuedBytes -= meteredBytes(rec);
          const k = header(rec, "k");
          const [i, n] = (header(rec, "p") ?? "0/1").split("/").map(Number);
          if (k === "ev" || (k === "part" && i === n - 1)) this.lastBseq = Math.max(this.lastBseq, Number(header(rec, "b")));
        }
        while (this.queue.length && this.queue[0].done === this.queue[0].records.length) this.queue.shift()!.resolve();
      },
      (e) => {
        this.failed = e;
        for (const item of this.queue.splice(0)) item.reject(e);
        this.queuedBytes = 0;
      },
    );
  }

  /** Appends one batch at nextSeq exactly once (see the header comment). */
  private async appendBatch(batch: AppendRecord[]) {
    const sleep = this.opts.sleep ?? defaultSleep;
    const maxAttempts = this.opts.maxAttempts ?? 40;
    const at = this.nextSeq;
    let ambiguous = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const ack = await this.s2.append(this.opts.streams.events, batch, { matchSeqNum: at, fencingToken: this.opts.fence });
        this.nextSeq = ack.end.seq_num;
        return;
      } catch (e) {
        if (e instanceof S2Error && e.status === 412) {
          if (e.body && "fencing_token_mismatch" in e.body) throw new FencedError(e.body.fencing_token_mismatch);
          const actual = Number(e.body?.seq_num_mismatch);
          if (ambiguous && actual === at + batch.length && (await this.isOurs(at, batch))) {
            this.stats.dedupedRetries++;
            this.nextSeq = actual;
            return;
          }
          throw new ConflictError(`events stream is at ${actual}, expected ${at}: another writer appended without the fence`);
        }
        if (e instanceof S2Error && e.unauthorized && this.opts.refreshToken && attempt <= 2) {
          this.s2 = this.s2.withToken(await this.opts.refreshToken());
          continue;
        }
        const transient = !(e instanceof S2Error) || e.retryable; // network errors are TypeErrors from fetch
        if (!transient || attempt >= maxAttempts) throw e;
        // A timeout or 5xx may have had a side effect: from now on a seq_num mismatch has to be checked against the stream.
        ambiguous = true;
        this.stats.retries++;
        await sleep(Math.min(5000, 100 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random()));
      }
    }
  }

  /** Whether the records at [at, at + batch.length) are exactly this batch. */
  private async isOurs(at: number, batch: AppendRecord[]) {
    const { records } = await this.s2.read(this.opts.streams.events, { seqNum: at }, { count: batch.length });
    if (records.length !== batch.length) return false;
    return records.every((r, i) => same(r, batch[i]));
  }

  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof S2Error && e.unauthorized && this.opts.refreshToken) {
        this.s2 = this.s2.withToken(await this.opts.refreshToken());
        return fn();
      }
      throw e;
    }
  }

  /**
   * Tails the commands stream from the cursor (long poll, 30 s) and yields each new command. bridge: the caller acks each one
   * whenever it is done with it (ack order is free); the next one is yielded meanwhile. Unacked commands come back after a
   * restart. Stop it with the signal.
   */
  async *commands(signal?: AbortSignal): AsyncGenerator<Command> {
    const sleep = this.opts.sleep ?? defaultSleep;
    const stream = this.opts.streams.commands;
    // Seed the dedupe set with the commands consumed just before the cursor.
    if (this.cursor > 0) {
      const from = Math.max(0, this.cursor - COMMAND_DEDUPE_WINDOW);
      const { records } = await this.withAuth(() => this.s2.read(stream, { seqNum: from }, { count: this.cursor - from }));
      for (const r of records) if (r.seq_num < this.cursor && !isCommandRecord(r)) this.remember(header(r, "id") ?? "");
    }
    let failures = 0;
    while (!signal?.aborted) {
      let records: SequencedRecord[];
      try {
        ({ records } = await this.withAuth(() => this.s2.read(stream, { seqNum: this.readPos }, { wait: 30, clamp: true, count: 100, signal })));
        failures = 0;
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof S2Error && !e.retryable && !e.unauthorized) throw e;
        await sleep(Math.min(10_000, 250 * 2 ** failures++));
        continue;
      }
      for (const r of records) {
        if (signal?.aborted) return;
        const cmd = this.take(r);
        if (cmd) yield cmd;
      }
    }
  }

  /** Cids delivered in this process or consumed before the cursor: a retried append of one is skipped. */
  private seen = new Set<string>();
  private remember(cid: string) {
    this.seen.add(cid);
    if (this.seen.size > COMMAND_DEDUPE_WINDOW * 4) this.seen.delete(this.seen.values().next().value!);
  }

  /** One record read from `commands`: the command to deliver, or null (a command record, an acked one, a duplicate). */
  private take(r: SequencedRecord): Command | null {
    this.readPos = r.seq_num + 1;
    if (isCommandRecord(r)) return null;
    const cid = header(r, "id") ?? `seq-${r.seq_num}`;
    if (this.resumedAhead.delete(cid)) {
      // Acked by the previous bridge, past its cursor: now that its seq_num is known it is tracked like one acked here.
      this.ackedAhead.set(r.seq_num, cid);
      this.remember(cid);
      if (!this.unacked.size) this.advanceCursor();
      return null;
    }
    if (this.seen.has(cid)) {
      this.stats.duplicatesSkipped++;
      if (!this.unacked.size) this.advanceCursor(); // nothing held back: the cursor may pass the duplicate
      return null;
    }
    this.remember(cid);
    const cmd: Command = { seq: r.seq_num, cid, body: r.body ?? "", by: header(r, "by") };
    this.unacked.set(cmd.seq, cmd);
    return cmd;
  }
}

const same = (r: SequencedRecord, a: AppendRecord) => (r.body ?? "") === (a.body ?? "") && JSON.stringify(r.headers ?? []) === JSON.stringify(a.headers ?? []);
