import { subscriptionView, type PrRef, type SubscriptionView } from "@dorks/shared";
import { samePr, toRef } from "./pr-ref";
import { errTag, type Log } from "./redact";
import { RpcError, type RpcMethods } from "./rpc";
import type { Transport } from "./transport";

// The bridge-side service behind the `pr.*` RPC methods. The backend owns the truth; this side only forwards `sub`/`unsub` to the backend
// (bridge.subscribe / bridge.unsubscribe) and serves `list` from a cached copy of the reactive `bridge.subscriptions`.

/** How long a backend call may take before the caller gets `unavailable` (the transport waits for the connection while offline). */
const BACKEND_WAIT_MS = 10_000;
/** How long `pr.list` waits for the very first copy of the subscriptions, and `pr.sub`/`unsub` for the cache to reflect their change. */
const FIRST_LIST_WAIT_MS = 5_000;
const SETTLE_WAIT_MS = 2_000;

function refParams(params: unknown): PrRef {
  const p = (params ?? {}) as { repo?: unknown; number?: unknown };
  const ref = typeof p.repo === "string" && typeof p.number === "number" ? toRef(p.repo, p.number) : null;
  if (!ref) throw new RpcError("invalid", "expected { repo: 'owner/name', number: positive integer }");
  return ref;
}

export class PrSubscriptions {
  private cache: SubscriptionView[] | null = null;
  private stopWatching: (() => void) | null = null;
  private waiters = new Set<() => void>();

  constructor(private t: Transport, private log: Log) {}

  readonly methods: RpcMethods = {
    "pr.sub": async (params) => {
      const ref = refParams(params);
      const source = (params as { source?: unknown }).source ?? "agent";
      if (source !== "auto" && source !== "agent") throw new RpcError("invalid", "source must be 'auto' or 'agent'");
      await this.subscribe(ref, source);
      return ref;
    },
    "pr.unsub": async (params) => {
      const ref = refParams(params);
      await this.unsubscribe(ref);
      return ref;
    },
    "pr.list": async () => {
      const list = await this.list();
      if (!list) throw new RpcError("unavailable", "the subscription list has not loaded yet (is the bridge connected?)");
      return list;
    },
  };

  /** Idempotent, like the backend. Resolves once the cached list shows the change, so a `list` right after reads its own write. */
  async subscribe(ref: PrRef, source: "auto" | "agent") {
    await this.backend(() => this.t.subscribePr(ref, source));
    await this.settled((l) => l.some((s) => samePr(s, ref)));
  }

  async unsubscribe(ref: PrRef) {
    await this.backend(() => this.t.unsubscribePr(ref));
    await this.settled((l) => !l.some((s) => samePr(s, ref)));
  }

  /** The cached subscriptions (waiting briefly for the first copy); null when the backend has not answered yet. */
  async list(): Promise<SubscriptionView[] | null> {
    if (!this.cache) await this.settled(() => true, FIRST_LIST_WAIT_MS);
    return this.cache;
  }

  /** (Re)opens the reactive `bridge.subscriptions` query. Called once the bridge is connected and again after each reconnect. */
  start() {
    this.stopWatching?.();
    this.stopWatching = this.t.subscribeSubscriptions(
      (raw) => {
        const parsed = subscriptionView.array().safeParse(raw);
        if (!parsed.success) return this.log("ignoring a malformed subscription list");
        this.cache = parsed.data;
        for (const w of [...this.waiters]) w();
      },
      () => this.log("subscriptions query error"),
    );
  }

  stop() {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async backend<T>(call: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new RpcError("unavailable", "the backend did not answer in time")), BACKEND_WAIT_MS)));
    try {
      return await Promise.race([call(), timeout]);
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const code = this.t.errorCode(e);
      this.log("backend call failed:", code ?? errTag(e));
      throw new RpcError(code ? "failed" : "unavailable", code ? `the backend refused the request (${code})` : "could not reach the backend");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves when the cached list satisfies `ok` (so `sub` then `list` reads its own write), or after `ms`. Never rejects. */
  private settled(ok: (l: SubscriptionView[]) => boolean, ms = SETTLE_WAIT_MS): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.cache || !ok(this.cache)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        resolve();
      }, ms);
      this.waiters.add(check);
      check();
    });
  }
}
