import { emptyView, fold, type ClientEvent, type DorkView } from "@dorks/shared";
import type { Api } from "./http.ts";
import { ApiError } from "./http.ts";
import type { Store } from "./store.ts";

export interface EventsState {
  /** The folded transcript, with not-yet-confirmed sends appended as user blocks. */
  view: DorkView;
  /** Nothing has loaded yet. */
  loading: boolean;
  /** Older events exist on the server. */
  canLoadMore: boolean;
  loadingMore: boolean;
  error: ApiError | undefined;
}

const EMPTY: EventsState = { view: emptyView(), loading: true, canLoadMore: false, loadingMore: false, error: undefined };

/**
 * The live transcript of one dork: the newest page, then a tail by `seq`, folded through the shared pure `fold`.
 *
 * A growing assistant message keeps ONE row whose text grows in place (same seq), so the tail re-reads from `lastSeq - 1`
 * (`after` is exclusive) and a row that comes back with a seq at or below what was folded forces a re-fold from scratch;
 * `fold` alone would ignore it. All network work runs one step at a time, so a tail can never overtake the first page.
 */
export class EventsFeed implements Store<EventsState> {
  private state = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly bySeq = new Map<number, ClientEvent>();
  private folded: DorkView = emptyView();
  private pending: { id: string; text: string }[] = [];
  private pendingCounter = 0;
  private oldest = Number.POSITIVE_INFINITY;
  private hasMore = false;
  private started = false;
  private loadingMore = false;
  private error: ApiError | undefined;
  private chain: Promise<void> = Promise.resolve();
  private tailQueued = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly api: Api;
  private readonly dorkId: string;
  private readonly pageSize: number;
  private readonly onUnauthorized: () => void;
  private readonly retryDelay: (n: number) => number;

  constructor(api: Api, dorkId: string, pageSize: number, onUnauthorized: () => void, retryDelay: (n: number) => number) {
    this.api = api;
    this.dorkId = dorkId;
    this.pageSize = pageSize;
    this.onUnauthorized = onUnauthorized;
    this.retryDelay = retryDelay;
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.requestTail(); // first page, or a catch-up after having been away
    return () => void this.listeners.delete(listener);
  };

  /** The live stream says the transcript advanced (or the connection was re-established): catch up. */
  requestTail() {
    if (this.listeners.size === 0 || this.tailQueued) return;
    this.tailQueued = true;
    this.enqueue(async () => {
      this.tailQueued = false;
      await this.tail();
    });
  }

  loadMore() {
    if (!this.started || !this.hasMore || this.loadingMore) return;
    this.loadingMore = true;
    this.publish();
    this.enqueue(async () => {
      try {
        const page = await this.api.events(this.dorkId, { before: this.oldest, limit: this.pageSize });
        this.upsert(page.events);
        this.hasMore = page.hasMore;
        this.error = undefined;
      } catch (e) {
        this.fail(e);
      } finally {
        this.loadingMore = false;
        this.publish();
      }
    });
  }

  /** Sends a message and shows it at once; if the server refuses, the optimistic row is removed and the error is rethrown. */
  async send(text: string): Promise<void> {
    const entry = { id: `pending-${this.pendingCounter++}`, text };
    this.pending.push(entry);
    this.publish();
    try {
      await this.api.sendMessage(this.dorkId, text);
    } catch (e) {
      this.pending = this.pending.filter((p) => p !== entry);
      this.publish();
      throw e;
    }
    this.requestTail();
  }

  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job, job);
  }

  private async tail() {
    try {
      if (!this.started) {
        const page = await this.api.events(this.dorkId, { limit: this.pageSize });
        this.started = true;
        this.hasMore = page.hasMore;
        this.upsert(page.events);
      } else {
        // `after` is exclusive; start one below the newest seq so a message that grew in place is re-read.
        let after = Math.max(0, this.folded.lastSeq - 1);
        for (;;) {
          const page = await this.api.events(this.dorkId, { after, limit: 200 });
          this.upsert(page.events);
          const last = page.events.at(-1)?.seq;
          if (!page.hasMore || last === undefined || last <= after) break;
          after = last;
        }
      }
      this.error = undefined;
      this.failures = 0;
    } catch (e) {
      this.fail(e);
    }
    this.publish();
  }

  private fail(e: unknown) {
    this.error = e instanceof ApiError ? e : new ApiError(0, { code: "failed", message: "Something went wrong" });
    if (this.error.status === 401) this.onUnauthorized();
    else if (this.listeners.size > 0 && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.requestTail();
      }, this.retryDelay(this.failures++));
    }
  }

  private upsert(events: ClientEvent[]) {
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    let refold = false;
    for (const e of ordered) {
      const known = this.bySeq.has(e.seq);
      this.bySeq.set(e.seq, e);
      this.oldest = Math.min(this.oldest, e.seq);
      if (e.type === "user_message" && !known) {
        const i = this.pending.findIndex((p) => p.text === e.text);
        if (i >= 0) this.pending.splice(i, 1); // the server has it now: the confirmed row replaces the optimistic one
      }
      if (e.seq > this.folded.lastSeq) this.folded = fold(this.folded, e);
      else refold = true; // older page, or a row rewritten in place
    }
    if (refold) {
      let v = emptyView();
      for (const e of [...this.bySeq.values()].sort((a, b) => a.seq - b.seq)) v = fold(v, e);
      this.folded = v;
    }
  }

  private publish() {
    const view: DorkView = this.pending.length
      ? { ...this.folded, blocks: [...this.folded.blocks, ...this.pending.map((p) => ({ kind: "user" as const, id: p.id, text: p.text }))] }
      : this.folded;
    this.state = { view, loading: !this.started && !this.error, canLoadMore: this.hasMore, loadingMore: this.loadingMore, error: this.error };
    for (const l of [...this.listeners]) l();
  }
}
