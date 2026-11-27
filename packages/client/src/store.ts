import { ApiError } from "./http.ts";

/** The `useSyncExternalStore` contract: `getSnapshot` returns the same object until something changed. */
export interface Store<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

export interface QueryState<T> {
  status: "loading" | "ready" | "error";
  data: T | undefined;
  error: ApiError | undefined;
}

export interface QueryOptions {
  /** Delay before retry number n (0-based) after a failed fetch. */
  retryDelay: (n: number) => number;
  /** A 401 is final: report it instead of retrying. */
  onUnauthorized: () => void;
}

/** An `until` patch is dropped this long after its write was confirmed, whatever the server says by then. */
const UNTIL_MAX_MS = 30_000;

/** A read this young is not fetched again for a new subscriber (a remount, a second component, a prefetch then the screen). */
const FRESH_MS = 2000;

/** An optimistic change, shown over the server's data until a read that started after the server confirmed it replaces it. */
export interface Optimistic {
  /** The server confirmed the change: keep showing it until a read started from now on lands (that read has it). */
  settle(): void;
  /** The server refused it: stop showing it now. */
  rollback(): void;
}

interface Patch<T> {
  apply: (data: T) => T;
  /** Kept past a newer read until this says the server's data has the change (what the server records later, as a poller does). */
  until?: (data: T) => boolean;
  /** When it was settled, for `until`'s limit. */
  settledTime?: number;
  /** The newest fetch generation when the server confirmed it; a fetch of a higher generation has the change. */
  settledAt?: number;
}

/**
 * One cached, refetchable read. It fetches while it has subscribers, keeps its last data when they all leave (so a remount
 * shows it at once, then revalidates), refetches on `invalidate()`, and coalesces invalidations that arrive mid-fetch into
 * exactly one more fetch.
 *
 * Writes show at once through `optimistic(apply)`: the patch is applied over the server's data, and again over every read
 * that lands while it is pending (a read that started before the write would otherwise put the old data back), until a read
 * that started after the server confirmed it lands, or the write fails and it is rolled back.
 */
/** Whether a read of generation `gen` that answered `data` has a patch's change, so it can stop being shown. */
function landed<T>(p: Patch<T>, gen: number, data: T): boolean {
  if (p.settledAt === undefined || p.settledAt >= gen) return false;
  return !p.until || p.until(data) || Date.now() - p.settledTime! > UNTIL_MAX_MS;
}

export class Query<T> implements Store<QueryState<T>> {
  /** What the server last said. `state` is it with the pending patches applied. */
  private base: QueryState<T> = { status: "loading", data: undefined, error: undefined };
  private state: QueryState<T> = this.base;
  private readonly listeners = new Set<() => void>();
  private inflight = false;
  private dirty = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private patches: Patch<T>[] = [];
  /** Generation of the newest fetch started. */
  private gen = 0;
  /** When the last successful read landed; 0 when an invalidation arrived since (nobody watched then). */
  private fetchedAt = 0;
  private lastStart = 0;
  /** When the last subscriber left (or the query was made); undefined while someone watches. The client drops long-idle queries. */
  idleSince: number | undefined = Date.now();

  private readonly fetcher: () => Promise<T>;
  private readonly opts: QueryOptions;

  constructor(fetcher: () => Promise<T>, opts: QueryOptions) {
    this.fetcher = fetcher;
    this.opts = opts;
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.idleSince = undefined;
    if (this.listeners.size === 1 && !this.inflight && Date.now() - this.fetchedAt > FRESH_MS) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.idleSince = Date.now();
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    };
  };

  /** Refetch now if anyone is watching; otherwise the next subscriber refetches. */
  invalidate() {
    if (this.listeners.size > 0) void this.refresh();
    else this.fetchedAt = 0;
  }

  /** Starts the read now, before anything shows it (its screen is about to): the subscriber then finds it in flight or fresh. */
  prefetch() {
    if (!this.inflight && Date.now() - this.fetchedAt > FRESH_MS) void this.refresh();
  }

  /** Data to show until the first read lands (a row of a list already loaded); ignored once the server answered. */
  seed(data: T) {
    if (this.base.data !== undefined || this.base.status !== "loading") return;
    this.base = { status: "ready", data, error: undefined };
    this.publish();
  }

  /** When the newest read started (0: none yet). */
  get startedAt(): number {
    return this.lastStart;
  }

  /** The data now, with pending changes; undefined before the first read. */
  get data(): T | undefined {
    return this.state.data;
  }

  /** Shows `apply(data)` at once (and over every read until settled and replaced, or rolled back). */
  optimistic(apply: (data: T) => T, until?: (data: T) => boolean): Optimistic {
    const patch: Patch<T> = { apply, until };
    this.patches.push(patch);
    this.publish();
    return {
      settle: () => {
        patch.settledAt = this.gen;
        patch.settledTime = Date.now();
      },
      rollback: () => {
        this.patches = this.patches.filter((p) => p !== patch);
        this.publish();
      },
    };
  }

  private publish() {
    const { data } = this.base;
    this.state = data !== undefined && this.patches.length ? { ...this.base, data: this.patches.reduce<T>((d, p) => p.apply(d), data) } : this.base;
    for (const l of [...this.listeners]) l();
  }

  private set(next: QueryState<T>) {
    this.base = next;
    this.publish();
  }

  private async refresh(): Promise<void> {
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.inflight = true;
    const gen = ++this.gen;
    this.lastStart = Date.now();
    try {
      const data = await this.fetcher();
      this.failures = 0;
      this.fetchedAt = Date.now();
      // Changes the server had confirmed before this read started are in it now.
      this.patches = this.patches.filter((p) => !landed(p, gen, data));
      this.set({ status: "ready", data, error: undefined });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, { code: "failed", message: "Something went wrong" });
      this.set({ status: "error", data: this.base.data, error });
      if (error.status === 401) this.opts.onUnauthorized();
      else if (this.listeners.size > 0) this.retryTimer = setTimeout(() => void this.refresh(), this.opts.retryDelay(this.failures++));
    } finally {
      this.inflight = false;
    }
    if (this.dirty) {
      this.dirty = false;
      void this.refresh();
    }
  }
}
