// Live updates for a Dorks Cloud org (Teams plan), which no server holds a stream open for: the org runtime publishes
// invalidations to the org's `live/feed` stream on s2, and each session's bridge appends its events to the session's `events`
// stream. Both are read straight from s2 with read-only tokens the Worker issues (`<realtimeUrl>/live-token`,
// `<realtimeUrl>/sessions/:id/read-token`). Feed records are the same `LiveMessage`s as `/api/live`; session records are the
// transcript's `ClientEvent`s themselves, so an open chat gets payloads, not invalidations. REST is unchanged.
// The desktop shell's CSP must allow these reads (`connect-src https://*.s2.dev` in apps/desktop/src-tauri/tauri.conf.json): without
// it WebKit refuses every s2 fetch and a cloud workspace sits on "Reconnecting to the server…".
import type { ClientEvent } from "@dorks/shared";
import { checkTail, StreamReader, timeoutSignal, type ReadGrant } from "./s2.ts";
import type { LiveStatus } from "./live.ts";
import type { LiveMessage, Person } from "./types.ts";

export interface CloudLiveConfig {
  /** The Worker's realtime routes for the org, through the home server: `<home>/api/cloud/orgs/:org/realtime`. */
  realtimeUrl: string;
  /** Reconnect every read with a fresh token at least this often (default 10 min: the Worker re-checks membership each time). */
  maxConnectionMs?: number;
  /** A team: show who looks at each chat (the org's `live/presence` stream) and say which one this client shows. */
  presence?: boolean;
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

/** A token route that has not answered in this long is given up and asked again (a stalled relay would hold the stream forever). */
const GRANT_TIMEOUT_MS = 15_000;

async function post<T>(o: Common, path: string): Promise<T> {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const signal = timeoutSignal(GRANT_TIMEOUT_MS);
  const res = await f(`${o.cloud.realtimeUrl.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: "{}", signal });
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

type LiveGrant = { token: string; expiresAt: number; urls: { feed: string; presence: string }; encryptionKey?: string | null };

/** The org's live token, shared by the feed and presence reads that open together (one token issuance, not two). */
function liveGrants(o: Common): () => Promise<LiveGrant> {
  let last: { at: number; grant: Promise<LiveGrant> } | undefined;
  return () => {
    if (!last || Date.now() - last.at > 5000) last = { at: Date.now(), grant: post<LiveGrant>(o, "/live-token") };
    const g = last.grant;
    g.catch(() => (last = undefined));
    return g;
  };
}

/**
 * The org feed, in place of `/api/live`: a `hello` when the read opens (and again after a failure), then each invalidation the
 * org runtime publishes. Returns a function that closes it.
 */
export function connectCloudLive(o: Common & { onMessage: (m: LiveMessage) => void; onStatus: (s: LiveStatus) => void; client?: string; viewing?: () => string | null }): {
  close: () => void;
  /** Tells teammates which chat this client shows now (and every 30 s while open). */
  beat: () => void;
} {
  const grants = liveGrants(o);
  const feed = followFeed(o, grants);
  const presence = o.cloud.presence && o.client ? followPresence({ ...o, client: o.client, viewing: o.viewing ?? (() => null) }, grants) : undefined;
  return {
    close: () => {
      feed();
      presence?.close();
    },
    beat: () => presence?.beat(),
  };
}

function followFeed(o: Common & { onMessage: (m: LiveMessage) => void; onStatus: (s: LiveStatus) => void }, grants: () => Promise<LiveGrant>): () => void {
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
          const g = await grants();
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

/** A client counts as looking at a chat this long after its last heartbeat (it beats every 30 s). */
const PRESENCE_TTL_MS = 60_000;
const BEAT_MS = 30_000;

/**
 * Presence for a team org: each client posts a heartbeat (`{sessionId, client}`; the Worker adds `by` and `name`) when it opens
 * a chat and every 30 s; everyone reads the org's `live/presence` stream from a minute back and counts a person as viewing a chat
 * while their newest heartbeat from some client names it and is under a minute old. Emits `{t: "presence"}` as `/api/live` does.
 */
function followPresence(o: Common & { onMessage: (m: LiveMessage) => void; client: string; viewing: () => string | null }, grants: () => Promise<LiveGrant>) {
  /** The newest heartbeat of each client (`by|client`), at s2's clock. */
  const beats = new Map<string, { id: string; name: string; sessionId: string | null; ts: number }>();
  /** How far this clock runs ahead of s2's, at most (the smallest receive time minus record time seen). */
  let skew = Number.POSITIVE_INFINITY;
  let shown = new Map<string, string>();
  const recompute = () => {
    const now = Date.now() - (Number.isFinite(skew) ? skew : 0);
    const by = new Map<string, Map<string, Person>>();
    for (const [key, b] of beats) {
      if (now - b.ts > PRESENCE_TTL_MS) beats.delete(key);
      else if (b.sessionId) {
        const people = by.get(b.sessionId) ?? new Map<string, Person>();
        people.set(b.id, { id: b.id, name: b.name });
        by.set(b.sessionId, people);
      }
    }
    const next = new Map([...by].map(([dorkId, people]) => [dorkId, JSON.stringify([...people.values()].sort((a, b) => a.id.localeCompare(b.id)))]));
    for (const dorkId of new Set([...shown.keys(), ...next.keys()])) {
      const viewers = next.get(dorkId);
      if (viewers !== shown.get(dorkId)) o.onMessage({ t: "presence", dorkId, viewers: viewers ? (JSON.parse(viewers) as Person[]) : [] });
    }
    shown = next;
  };
  const beat = () => {
    const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    void f(`${o.cloud.realtimeUrl.replace(/\/+$/, "")}/presence`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: o.viewing(), client: o.client }),
    }).catch(() => {}); // best effort, like /api/presence
  };
  const timers = [setInterval(beat, BEAT_MS), setInterval(recompute, 10_000)];
  let lastSeq = -1;
  const stop = supervise(
    o,
    async (signal) => {
      const reader = new StreamReader({
        raw: true,
        afterSeq: lastSeq,
        fromTimestamp: Date.now() - PRESENCE_TTL_MS - 60_000, // a minute back, plus room for clock skew
        maxConnectionMs: o.cloud.maxConnectionMs,
        fetch: o.fetch,
        grant: async () => {
          const g = await grants();
          return { token: g.token, url: g.urls.presence, expiresAt: g.expiresAt, encryptionKey: g.encryptionKey };
        },
      });
      for await (const item of reader.items(signal)) {
        lastSeq = reader.lastSeq;
        if (item.kind !== "record") continue;
        try {
          const b = JSON.parse(item.body) as { by?: unknown; name?: unknown; sessionId?: unknown; client?: unknown };
          if (typeof b.by !== "string") continue;
          skew = Math.min(skew, Date.now() - item.timestamp);
          const key = `${b.by}|${typeof b.client === "string" ? b.client : ""}`;
          if ((beats.get(key)?.ts ?? -1) > item.timestamp) continue;
          beats.set(key, { id: b.by, name: typeof b.name === "string" && b.name ? b.name : "Teammate", sessionId: typeof b.sessionId === "string" ? b.sessionId : null, ts: item.timestamp });
        } catch {
          continue;
        }
        recompute();
      }
    },
    () => {},
  );
  return {
    beat,
    close: () => {
      for (const t of timers) clearInterval(t);
      stop();
    },
  };
}

/** Where a session's read stands, kept across follows: the next one resumes after it. */
export interface SessionCursor {
  seq: number;
  bseq: number;
}

/** Events per record in a session's numbering: the Worker's REST page (dorks-cloud src/runtime/events.ts) numbers them the same. */
export const SEQ_PER_RECORD = 1000;

/**
 * One record's client events, as transcript rows. The bridge writes each agent line's events, and each card it adds (a "note"), as
 * one record whose body is a JSON array of event bodies; an event's seq is the record's s2 seq_num * 1000 + its index there, its ts
 * the record's timestamp. A body that is one object is one event.
 */
export function sessionEvents(dorkId: string, seq: number, timestamp: number, body: string): ClientEvent[] {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return [];
  }
  return (Array.isArray(v) ? v : [v])
    .slice(0, SEQ_PER_RECORD)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string")
    .map((e, i) => ({ ...e, seq: seq * SEQ_PER_RECORD + i, dorkId, ts: timestamp }) as unknown as ClientEvent);
}

/** The user_message a command echo stands for (a `user_message` CommandFrame), as its transcript row; none for other commands. */
export function messageEvents(dorkId: string, seq: number, timestamp: number, body: string): ClientEvent[] {
  let f: { t?: unknown; text?: unknown; by?: { id?: unknown; name?: unknown } };
  try {
    f = JSON.parse(body);
  } catch {
    return [];
  }
  if (f?.t !== "user_message" || typeof f.text !== "string") return [];
  const by = f.by && typeof f.by.id === "string" ? { id: f.by.id, name: typeof f.by.name === "string" ? f.by.name : "" } : undefined;
  return sessionEvents(dorkId, seq, timestamp, JSON.stringify([{ type: "user_message", text: f.text, ...(by ? { by } : {}) }]));
}

/**
 * Follows one session's `events` stream into the transcript. The first follow calls `ready` (the transcript reads its newest page over
 * REST) while it checks the stream's tail, calls `ready` again once the tail is placed (the transcript reads what landed meanwhile),
 * then reads from that tail, so nothing appended between them is missed. Later
 * follows resume after `cursor`. Events arrive in batches; an event read twice (REST and s2) is the same row, and the transcript
 * keeps one. Returns a function that stops it.
 */
export function followSession(
  o: Common & {
    dorkId: string;
    cursor: SessionCursor | null;
    /** A read grant kept from an earlier follow of this session: reused while valid, so reopening a chat issues no new token. */
    cached?: { get: () => ReadGrant | undefined; set: (g: ReadGrant) => void };
    ready: () => void;
    onEvents: (events: ClientEvent[], cursor: SessionCursor) => void;
    onUnauthorized: () => void;
  },
): () => void {
  let cursor = o.cursor;
  let readied = false;
  let retried = false;
  const ready = () => {
    if (readied) return;
    readied = true;
    o.ready();
  };
  const grant = async () => {
    const g = await post<ReadGrant>(o, `/sessions/${encodeURIComponent(o.dorkId)}/read-token`);
    o.cached?.set(g);
    return g;
  };
  return supervise(
    o,
    async (signal) => {
      // Only the first grant of a follow's first run may come from the cache: a later ask, or a run retried after a failure
      // (a refused tail check included), means that grant may be revoked, so the Worker is asked again.
      const kept = retried ? undefined : o.cached?.get();
      retried = true;
      let first: ReadGrant | null = kept && kept.expiresAt - Date.now() > 60_000 ? kept : null;
      if (!cursor) {
        // The newest page loads over REST while the stream is placed (a read grant, then its tail: two round trips), not after.
        ready();
        first ??= await grant();
        cursor = { seq: (await checkTail(first, o.fetch)) - 1, bseq: 0 };
        // Then one more REST read, after the tail was placed: it has whatever landed between the first page and the tail.
        o.ready();
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
        // Never past an event still being assembled: a new reader starts with no parts, so it must re-read them all.
        cursor = { seq: reader.assembler.safeSeq, bseq: reader.assembler.lastBseq };
        o.onEvents(events, cursor);
      };
      try {
        for await (const item of reader.items(signal)) {
          // A person's message is its command's echo (the bridge writes no event for it); other echoes, and the Worker's own messages
          // to the agent (by "worker": a build decision), are not transcript events.
          const events =
            item.kind === "command" ? (item.by === "worker" ? [] : messageEvents(o.dorkId, item.seq, item.timestamp, item.body)) : sessionEvents(o.dorkId, item.seq, item.timestamp, item.body);
          if (!events.length) continue;
          batch.push(...events);
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
