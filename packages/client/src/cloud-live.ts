// Live updates for a Dorks Cloud org (Teams or Cloud plan), which no server holds a stream open for: the org runtime publishes
// invalidations to the org's `live/feed` stream on s2, and each session's bridge appends its events to the session's `events`
// stream. Both are read straight from s2 with read-only tokens the Worker issues (`<realtimeUrl>/live-token`,
// `<realtimeUrl>/sessions/:id/read-token`). Feed records are the same `LiveMessage`s as `/api/live`; session records are the
// transcript's `ClientEvent`s themselves, so an open chat gets payloads, not invalidations. REST is unchanged.
import type { ClientEvent } from "@dorks/shared";
import { checkTail, StreamReader, type ReadGrant } from "./s2.ts";
import type { LiveStatus } from "./live.ts";
import type { LiveMessage } from "./types.ts";

export interface CloudLiveConfig {
  /** The Worker's realtime routes for the org, through the home server: `<home>/api/cloud/orgs/:org/realtime`. */
  realtimeUrl: string;
  /** Reconnect every read with a fresh token at least this often (default 10 min: the Worker re-checks membership each time). */
  maxConnectionMs?: number;
}

interface Common {
  cloud: CloudLiveConfig;
  /** The bearer token for the realtime routes (the home server's owner token). */
  token: string;
  fetch?: typeof fetch;
  backoff?: (attempt: number) => number;
}

const defaultBackoff = (n: number) => Math.min(10_000, 500 * 2 ** n);

/** A token route's refusal: 401 means the app's own token is wrong; anything else is retried. */
class GrantError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`read token refused (${status})`);
    this.status = status;
  }
}

async function post<T>(o: Common, path: string): Promise<T> {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const res = await f(`${o.cloud.realtimeUrl.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new GrantError(res.status);
  return (await res.json()) as T;
}

/** Runs `run` again with backoff whenever it fails, until stopped; a 401 from a token route stops it for good. */
function supervise(o: Common, run: (signal: AbortSignal) => Promise<void>, onFail: (unauthorized: boolean) => void): () => void {
  const abort = new AbortController();
  const backoff = o.backoff ?? defaultBackoff;
  let attempt = 0;
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        await run(abort.signal);
        attempt = 0;
      } catch (e) {
        if (abort.signal.aborted) return;
        const unauthorized = e instanceof GrantError && e.status === 401;
        onFail(unauthorized);
        if (unauthorized) return; // a wrong token never fixes itself; the app has to ask for a new one
        await new Promise((r) => setTimeout(r, backoff(attempt++)));
      }
    }
  })();
  return () => abort.abort();
}

/**
 * The org feed, in place of `/api/live`: a `hello` when the read opens (and again after a failure), then each invalidation the
 * org runtime publishes. Returns a function that closes it.
 */
export function connectCloudLive(o: Common & { onMessage: (m: LiveMessage) => void; onStatus: (s: LiveStatus) => void }): () => void {
  let lastSeq = -1;
  let hello = true;
  o.onStatus("connecting");
  return supervise(
    o,
    async (signal) => {
      const reader = new StreamReader({
        raw: true,
        afterSeq: lastSeq,
        // The feed holds invalidations, not state: the first read starts now, and the `hello` makes the app refetch what it shows.
        fromTimestamp: Date.now(),
        maxConnectionMs: o.cloud.maxConnectionMs,
        fetch: o.fetch,
        grant: async () => {
          const g = await post<{ token: string; expiresAt: number; urls: { feed: string }; encryptionKey?: string | null }>(o, "/live-token");
          return { token: g.token, url: g.urls.feed, expiresAt: g.expiresAt, encryptionKey: g.encryptionKey };
        },
        onConnect: () => {
          if (!hello) return;
          hello = false;
          o.onStatus("live");
          o.onMessage({ t: "hello", now: Date.now() });
        },
      });
      for await (const item of reader.items(signal)) {
        lastSeq = reader.lastSeq;
        if (item.kind !== "record") continue;
        try {
          o.onMessage(JSON.parse(item.body) as LiveMessage);
        } catch {
          // a malformed record is dropped; the next hello resynchronizes everything
        }
      }
    },
    (unauthorized) => {
      hello = true;
      o.onStatus(unauthorized ? "unauthorized" : "offline");
    },
  );
}

/** Where a session's read stands, kept across follows: the next one resumes after it. */
export interface SessionCursor {
  seq: number;
  bseq: number;
}

/**
 * Follows one session's `events` stream into the transcript. The first follow checks the stream's tail, then calls `ready` (the
 * transcript reads its newest page over REST), then reads from that tail, so nothing appended between the two is missed. Later
 * follows resume after `cursor`. Events arrive in batches; an event read twice (REST and s2) is the same row, and the transcript
 * keeps one. Returns a function that stops it.
 */
export function followSession(
  o: Common & { dorkId: string; cursor: SessionCursor | null; ready: () => void; onEvents: (events: ClientEvent[], cursor: SessionCursor) => void; onUnauthorized: () => void },
): () => void {
  let cursor = o.cursor;
  let readied = false;
  const ready = () => {
    if (readied) return;
    readied = true;
    o.ready();
  };
  const grant = () => post<ReadGrant>(o, `/sessions/${encodeURIComponent(o.dorkId)}/read-token`);
  return supervise(
    o,
    async (signal) => {
      let first: ReadGrant | null = null;
      if (!cursor) {
        first = await grant();
        cursor = { seq: (await checkTail(first, o.fetch)) - 1, bseq: 0 };
      }
      ready();
      const reader = new StreamReader({
        afterSeq: cursor.seq,
        afterBseq: cursor.bseq,
        maxConnectionMs: o.cloud.maxConnectionMs,
        fetch: o.fetch,
        grant: async () => {
          const g = first ?? (await grant());
          first = null;
          return g;
        },
      });
      let batch: ClientEvent[] = [];
      let flush: ReturnType<typeof setTimeout> | undefined;
      const emit = () => {
        flush = undefined;
        const events = batch;
        batch = [];
        cursor = { seq: reader.assembler.lastSeq, bseq: reader.assembler.lastBseq };
        o.onEvents(events, cursor);
      };
      try {
        for await (const item of reader.items(signal)) {
          if (item.kind !== "event") continue; // command echoes: the bridge writes the user's message as an event too
          try {
            batch.push(JSON.parse(item.body) as ClientEvent);
          } catch {
            continue;
          }
          // One s2 batch arrives as a burst of items: hand it over once.
          flush ??= setTimeout(emit, 0);
        }
      } finally {
        if (flush) {
          clearTimeout(flush);
          if (!signal.aborted) emit();
        }
      }
    },
    (unauthorized) => {
      ready(); // the transcript still loads over REST while s2 cannot be read
      if (unauthorized) o.onUnauthorized();
    },
  );
}
