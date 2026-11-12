import type { FromBridge } from "@dorks/shared";
import type { PushResult, Transport } from "./transport";
import { errTag, type Log } from "./redact";

interface Item {
  frame: FromBridge;
  /** Set for `event` frames. */
  bseq?: number;
  sent: boolean;
  bytes: number;
}

export interface OutboxOptions {
  batchMs: number;
  maxFrames?: number;
  maxBytes?: number;
  /** Already-delivered events kept around so a gap report from the backend can be replayed. */
  retainEvents?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  onFatal: (err: unknown) => void;
  rand?: () => number;
  /** Largest event the backend accepts (it rejects a bigger one with `event_too_large`). */
  maxEventBytes?: number;
  /** Retained events were renumbered (the backend's expected seq predates the replay window); `last` is the new highest bseq. */
  onRenumbered?: (last: number) => void;
  /** The backend is ahead of everything we hold: future events must be numbered above `seq`. */
  onBackendAhead?: (seq: number) => void;
}

/**
 * Ordered, retry-forever outbound queue. Frames leave in order, one batch in flight at a time; a failed batch is retried with
 * capped exponential backoff and never dropped. Events (which carry a bseq) are retained after delivery so that:
 *   - after a reconnect, everything above the backend's `afterBridgeSeq` is replayed ({@link rewindAfter});
 *   - a push that answers `{ expectedBseq }` (the backend saw a gap) is replayed from that seq. Backends that return
 *     nothing are treated as success, so this is feature-detected, not required.
 * Control frames (ack/ready/agent_exited/flushed) are retained only until delivered.
 */
export class Outbox {
  private items: Item[] = [];
  private cursor = 0; // every item before this index is `sent`
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private attempt = 0;
  private waiters: (() => void)[] = [];
  private readonly o: Required<Omit<OutboxOptions, "onFatal" | "onRenumbered" | "onBackendAhead">> & Pick<OutboxOptions, "onFatal" | "onRenumbered" | "onBackendAhead">;

  constructor(
    private transport: Transport,
    private log: Log,
    opts: OutboxOptions,
  ) {
    this.o = { maxFrames: 100, maxBytes: 512 * 1024, retainEvents: 2000, backoffBaseMs: 500, backoffCapMs: 30_000, rand: Math.random, maxEventBytes: 200 * 1024, ...opts };
  }

  push(frame: FromBridge) {
    const bytes = JSON.stringify(frame).length;
    this.items.push({ frame, bseq: frame.t === "event" ? frame.bseq : undefined, sent: false, bytes });
    this.kick();
  }

  /** Number of frames not yet delivered. */
  get pending() {
    let n = 0;
    for (let i = this.cursor; i < this.items.length; i++) if (!this.items[i].sent) n++;
    return n;
  }

  /** Send soon (debounced by batchMs so bursts share one mutation). */
  kick() {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.o.batchMs);
  }

  /** Send now, without waiting out the debounce. */
  flushNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.run();
  }

  /** Resolves once everything queued so far has been delivered. */
  drained(): Promise<void> {
    if (this.pending === 0 && !this.running) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resolveWaiters();
  }

  /** After a (re)connect: the backend has stored events up to `seq`; resend every retained event above it. */
  rewindAfter(seq: number) {
    this.rewindToIndex(this.items.findIndex((i) => i.bseq !== undefined && i.bseq > seq));
    this.kick();
  }

  /** Backend reported a gap: it wants `expectedBseq` next. */
  private rewindFrom(expectedBseq: number) {
    const events = this.items.filter((i) => i.bseq !== undefined);
    const idx = this.items.findIndex((i) => i.bseq !== undefined && i.bseq >= expectedBseq);
    if (idx < 0) {
      // Everything we hold is below what the backend wants: it is ahead of us. Nothing to resend; number future events above it.
      this.o.onBackendAhead?.(expectedBseq - 1);
      return;
    }
    if (events[0].bseq! > expectedBseq) {
      // The events the backend is missing have left the replay window, so they can never be resent. Resending the older-numbered
      // ones would be rejected forever: renumber what we still hold so the stream continues at the seq the backend expects.
      this.log("replay window no longer holds seq", expectedBseq, "- renumbering the", events.length, "retained events from it");
      let n = expectedBseq;
      for (const it of this.items) {
        if (it.bseq === undefined) continue;
        it.bseq = n++;
        it.frame = { ...(it.frame as Extract<FromBridge, { t: "event" }>), bseq: it.bseq };
      }
      this.rewindToIndex(this.items.findIndex((i) => i.bseq !== undefined));
      this.o.onRenumbered?.(n - 1);
      return;
    }
    this.rewindToIndex(idx);
  }

  private rewindToIndex(idx: number) {
    if (idx < 0) return;
    // Only events are resent. A control frame that was delivered (ack/ready/agent_exited/flushed) stays delivered; one that was in a
    // rejected batch was never marked sent, so it is still queued in its place.
    for (let i = idx; i < this.items.length; i++) if (this.items[i].bseq !== undefined) this.items[i].sent = false;
    this.cursor = Math.min(this.cursor, idx);
  }

  private async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const batch = this.nextBatch();
        if (!batch.length) break;
        let res: PushResult;
        try {
          res = await this.transport.push(batch.map((b) => b.frame));
        } catch (e) {
          if (await this.onPushError(batch, e)) return;
          continue;
        }
        if (await this.onPushRefused(res)) continue;
        this.attempt = 0;
        for (const b of batch) b.sent = true;
        this.advance();
      }
    } finally {
      this.running = false;
      if (this.pending === 0) this.resolveWaiters();
      else if (!this.stopped && !this.timer) this.kick();
    }
  }

  /** A push threw. Returns true when the error is fatal and the outbox has stopped; otherwise the batch is retried. */
  private async onPushError(batch: Item[], e: unknown): Promise<boolean> {
    if (this.transport.isFatal(e)) {
      this.stopped = true;
      this.o.onFatal(e);
      return true;
    }
    const code = this.transport.errorCode(e);
    if (code === "too_many_frames" && batch.length > 1) {
      this.o.maxFrames = Math.max(1, Math.floor(batch.length / 2)); // the backend's per-push cap is below ours: split
      this.log("push batch too large, splitting to", this.o.maxFrames, "frames");
      return false;
    }
    if (code === "event_too_large" && this.stubOversized(batch)) return false;
    await this.backoff(code ?? errTag(e));
    return false;
  }

  /** The push returned but the backend did not accept the batch (a gap, or a plain refusal). Returns true when it must be retried. */
  private async onPushRefused(res: PushResult): Promise<boolean> {
    const r = res as { ok?: unknown; expectedBseq?: unknown } | null | undefined;
    const expected = r?.expectedBseq;
    if (typeof expected === "number" && Number.isInteger(expected)) {
      this.log("backend reported a gap, replaying from", expected);
      this.rewindFrom(expected);
      await this.backoff("gap"); // bounded even if the backend keeps disagreeing
      return true;
    }
    if (r?.ok === false) {
      await this.backoff("rejected"); // refused without telling us where to resume: retry, never drop
      return true;
    }
    return false;
  }

  /**
   * The backend refused an event as too large. Replace the oversized event(s) of this batch with a stub that keeps the same bseq (so
   * numbering stays dense and the stream is not blocked behind it). Returns false when nothing in the batch can be shrunk.
   */
  private stubOversized(batch: Item[]): boolean {
    const events = batch.filter((i) => i.bseq !== undefined && i.frame.t === "event" && !(i.frame.raw as { truncated?: boolean } | null)?.truncated);
    if (!events.length) return false;
    let victims = events.filter((i) => i.bytes > this.o.maxEventBytes);
    if (!victims.length) victims = [events.reduce((a, b) => (b.bytes > a.bytes ? b : a))];
    for (const it of victims) {
      const raw = (it.frame as Extract<FromBridge, { t: "event" }>).raw as { type?: string } | null;
      it.frame = { t: "event", bseq: it.bseq!, raw: { type: raw?.type, truncated: true } };
      it.bytes = JSON.stringify(it.frame).length;
    }
    this.log("replaced", victims.length, "oversized event(s) with stubs, keeping their seq");
    return true;
  }

  private nextBatch(): Item[] {
    const out: Item[] = [];
    let bytes = 0;
    for (let i = this.cursor; i < this.items.length && out.length < this.o.maxFrames; i++) {
      const it = this.items[i];
      if (it.sent) continue;
      if (out.length && bytes + it.bytes > this.o.maxBytes) break;
      out.push(it);
      bytes += it.bytes;
    }
    return out;
  }

  private advance() {
    while (this.cursor < this.items.length && this.items[this.cursor].sent) this.cursor++;
    // Trim the delivered prefix: control frames immediately, events beyond the replay window.
    let retained = 0;
    for (let i = this.cursor - 1; i >= 0; i--) if (this.items[i].bseq !== undefined) retained++;
    let drop = 0;
    while (drop < this.cursor && (this.items[drop].bseq === undefined || retained > this.o.retainEvents)) {
      if (this.items[drop].bseq !== undefined) retained--;
      drop++;
    }
    if (drop) {
      this.items.splice(0, drop);
      this.cursor -= drop;
    }
  }

  private async backoff(why: string) {
    const ms = Math.min(this.o.backoffCapMs, this.o.backoffBaseMs * 2 ** this.attempt++);
    const jittered = Math.round(ms * (0.5 + this.o.rand() / 2));
    if (this.attempt === 1 || this.attempt % 10 === 0) this.log(`push failed (${why}), retrying; ${this.pending} frames queued, attempt ${this.attempt}`);
    await new Promise((r) => setTimeout(r, jittered));
  }

  private resolveWaiters() {
    for (const w of this.waiters.splice(0)) w();
  }
}
