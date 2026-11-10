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

/**
 * One cached, refetchable read. It fetches while it has subscribers, keeps its last data when they all leave (so a remount
 * shows it at once, then revalidates), refetches on `invalidate()`, and coalesces invalidations that arrive mid-fetch into
 * exactly one more fetch.
 */
export class Query<T> implements Store<QueryState<T>> {
  private state: QueryState<T> = { status: "loading", data: undefined, error: undefined };
  private readonly listeners = new Set<() => void>();
  private inflight = false;
  private dirty = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly fetcher: () => Promise<T>;
  private readonly opts: QueryOptions;

  constructor(fetcher: () => Promise<T>, opts: QueryOptions) {
    this.fetcher = fetcher;
    this.opts = opts;
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    };
  };

  /** Refetch now if anyone is watching; otherwise the next subscriber refetches anyway. */
  invalidate() {
    if (this.listeners.size > 0) void this.refresh();
  }

  private set(next: QueryState<T>) {
    this.state = next;
    for (const l of [...this.listeners]) l();
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
    try {
      const data = await this.fetcher();
      this.failures = 0;
      this.set({ status: "ready", data, error: undefined });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, { code: "failed", message: "Something went wrong" });
      this.set({ status: "error", data: this.state.data, error });
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
