import type { SubscriptionView } from "@dorks/shared";
import { EventsFeed } from "./events.ts";
import { createApi, ApiError, type ApiConfig } from "./http.ts";
import { connectLive, type LiveStatus } from "./live.ts";
import { Query, type QueryOptions, type Store } from "./store.ts";
import type { CreateDorkInput, Dork, LiveMessage, PrRefInput, Settings, SettingsPatch, SnapshotStatus } from "./types.ts";

export interface ClientConfig extends ApiConfig {
  /** Events fetched per page. */
  pageSize?: number;
  /** Delay before retry n of a failed read and before reconnect attempt n of the live stream. */
  retryDelay?: (n: number) => number;
}

export interface ConnectionState {
  live: LiveStatus;
  /** The server answered 401: the owner token is wrong, and nothing will succeed until the app supplies a new one. */
  unauthorized: boolean;
}

const defaultRetry = (n: number) => Math.min(15_000, 1000 * 2 ** n);

/**
 * Everything the UI reads and writes, over loopback HTTP + the `/api/live` SSE stream. Framework-agnostic: each read is a
 * `Store` (the `useSyncExternalStore` contract), so React hooks in ./react.tsx are thin and other UIs can use it directly.
 * Live messages are only invalidations; the data always comes from a plain HTTP read.
 */
export class DorksClient {
  readonly api;
  private readonly cfg: ClientConfig;
  private readonly queries = new Map<string, Query<unknown>>();
  private readonly feeds = new Map<string, EventsFeed>();
  private closeLive: (() => void) | undefined;
  private connection: ConnectionState = { live: "connecting", unauthorized: false };
  private readonly connListeners = new Set<() => void>();
  private readonly qopts: QueryOptions;

  constructor(config: ClientConfig) {
    this.cfg = config;
    this.api = createApi(config);
    this.qopts = { retryDelay: config.retryDelay ?? defaultRetry, onUnauthorized: () => this.setConnection({ unauthorized: true }) };
  }

  /** Opens the live stream. Safe to call again after `close()`. */
  start() {
    if (this.closeLive) return;
    this.closeLive = connectLive({
      baseUrl: this.cfg.baseUrl,
      token: this.cfg.token,
      fetch: this.cfg.fetch,
      backoff: this.cfg.retryDelay,
      onStatus: (live) => this.setConnection({ live, ...(live === "unauthorized" ? { unauthorized: true } : {}) }),
      onMessage: (m) => this.onLive(m),
    });
  }

  close() {
    this.closeLive?.();
    this.closeLive = undefined;
  }

  readonly connectionStore: Store<ConnectionState> = {
    getSnapshot: () => this.connection,
    subscribe: (l) => {
      this.connListeners.add(l);
      return () => void this.connListeners.delete(l);
    },
  };

  private setConnection(patch: Partial<ConnectionState>) {
    const next = { ...this.connection, ...patch };
    if (next.live === this.connection.live && next.unauthorized === this.connection.unauthorized) return;
    this.connection = next;
    for (const l of [...this.connListeners]) l();
  }

  private query<T>(key: string, fetcher: () => Promise<T>): Query<T> {
    let q = this.queries.get(key) as Query<T> | undefined;
    if (!q) {
      q = new Query(fetcher, this.qopts);
      this.queries.set(key, q as Query<unknown>);
    }
    return q;
  }

  private invalidate(prefix: string) {
    for (const [key, q] of this.queries) if (key === prefix || key.startsWith(`${prefix}:`)) q.invalidate();
  }

  private onLive(m: LiveMessage) {
    switch (m.t) {
      case "hello":
        for (const q of this.queries.values()) q.invalidate();
        for (const f of this.feeds.values()) f.requestTail();
        break;
      case "dorks":
        this.invalidate("dorks");
        break;
      case "dork":
        this.invalidate(`dork:${m.dorkId}`);
        break;
      case "events":
        this.feeds.get(m.dorkId)?.requestTail();
        break;
      case "subscriptions":
        this.invalidate(`subs:${m.dorkId}`);
        break;
      case "settings":
        this.invalidate("settings");
        this.invalidate("secrets");
        break;
      case "snapshot":
        this.invalidate("snapshot");
        break;
    }
  }

  // ---- reads (stores) ----

  dorks(archived = false) {
    return this.query(`dorks:${archived}`, () => this.api.listDorks(archived));
  }

  /** `null` when the server says it does not exist. */
  dork(id: string) {
    return this.query<Dork | null>(`dork:${id}`, async () => {
      try {
        return await this.api.getDork(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  settings() {
    return this.query<Settings>("settings", () => this.api.getSettings());
  }

  /** The base-snapshot build ("Prepare Boat"). The live stream refreshes it at every step. */
  snapshot() {
    return this.query<SnapshotStatus>("snapshot", () => this.api.getSnapshot());
  }

  secretNames() {
    return this.query<string[]>("secrets", () => this.api.listSecrets());
  }

  subscriptions(dorkId: string) {
    return this.query<SubscriptionView[]>(`subs:${dorkId}`, () => this.api.listSubscriptions(dorkId));
  }

  events(dorkId: string): EventsFeed {
    let f = this.feeds.get(dorkId);
    if (!f) {
      f = new EventsFeed(this.api, dorkId, this.cfg.pageSize ?? 40, this.qopts.onUnauthorized, this.qopts.retryDelay);
      this.feeds.set(dorkId, f);
    }
    return f;
  }

  // ---- writes: the API call, then an immediate refetch of what it changed (the live stream would do it too, a beat later) ----

  readonly actions = {
    createDork: async (input: CreateDorkInput) => {
      const r = await this.api.createDork(input);
      this.invalidate("dorks");
      return r;
    },
    renameDork: async (id: string, title: string) => {
      await this.api.renameDork(id, title);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    deleteDork: async (id: string) => {
      await this.api.deleteDork(id);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    archiveDork: async (id: string, archived: boolean) => {
      await this.api.setArchived(id, archived);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    interrupt: async (id: string) => {
      await this.api.interrupt(id);
      this.invalidate(`dork:${id}`);
    },
    chooseCodexModel: async (id: string, model: string, effort: string) => {
      await this.api.chooseCodexModel(id, model, effort);
      this.invalidate(`dork:${id}`);
    },
    /** Sends with an optimistic row; see EventsFeed.send. */
    sendMessage: (id: string, text: string) => this.events(id).send(text),
    subscribe: async (id: string, pr: PrRefInput) => {
      await this.api.subscribe(id, pr);
      this.invalidate(`subs:${id}`);
    },
    unsubscribe: async (id: string, pr: PrRefInput) => {
      await this.api.unsubscribe(id, pr);
      this.invalidate(`subs:${id}`);
    },
    resumeSubscription: async (id: string, pr: PrRefInput) => {
      await this.api.resumeSubscription(id, pr);
      this.invalidate(`subs:${id}`);
    },
    updateSettings: async (patch: SettingsPatch) => {
      await this.api.updateSettings(patch);
      this.invalidate("settings");
    },
    checkBoat: (input: { boatKey?: string; boatOrg?: string }) => this.api.checkBoat(input),
    /** Starts "Prepare Boat". Resolves with the status right after it started; follow progress with `snapshot()` / `useSnapshot()`. */
    buildSnapshot: async (force = false) => {
      try {
        return await this.api.buildSnapshot(force);
      } finally {
        this.invalidate("snapshot");
        this.invalidate("settings");
      }
    },
    setSecret: async (name: string, value: string) => {
      await this.api.setSecret(name, value);
      this.invalidate("secrets");
    },
    deleteSecret: async (name: string) => {
      await this.api.deleteSecret(name);
      this.invalidate("secrets");
    },
  };
}

export function createClient(config: ClientConfig): DorksClient {
  return new DorksClient(config);
}
