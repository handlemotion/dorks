// The layout of a session's s2 records. Ported from handlemotion/dorks-cloud src/realtime @ df775f3 (records.ts), which owns the format; the
// additions here are marked "bridge:" and are ignored by readers that predate them.
//
// Every record the bridge appends to `events` carries headers:
//   k  kind: "ev" (one agent stream line, normalized), "part" (a slice of an "ev" too big for one record), "cmd" (a command
//      the bridge consumed, echoed so readers see input and output in the order the agent did), and, bridge:
//      "note" (client events the bridge adds itself: the agent exited, a provider issue) and
//      "ret" (the answer to a `call` command: the Files tab)
//   b  the bridge's sequence number (bseq) of the event: strictly increasing per session, the bridge's dedupe key. For every
//      other kind it is the last bseq written so far.
//   c  the command cursor: the first `commands` seq_num the bridge has not acked yet. A restarted bridge reads from there.
//   a  bridge: cids at or after the cursor that are already acked (commands can be acked out of order: a message waits for
//      the agent while the configure after it is done), comma separated; absent when none. A restarted bridge skips them.
//   p  for "part": "<i>/<n>" (0-based)
//   id for "cmd" and "ret": the command id (cid)
// Bodies are UTF-8 JSON. "ev" and "note" bodies are a JSON array of ClientEventBody (one agent line can give several events, or
// none: then nothing is written for it). "cmd" bodies are the command as the Worker appended it; "ret" bodies are
// {id, ok, result} or {id, ok: false, error}. Records written by s2 itself (fence, trim) are command records; readers skip them.

import { isCommandRecord, type AppendRecord, type SequencedRecord } from "./s2";

/** s2's limits: a record and a batch are at most 1 MiB metered, a batch at most 1000 records (https://s2.dev/docs/platform/limits). */
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_BATCH_RECORDS = 1000;
/** We split anything bigger than this into parts, leaving room for headers. */
export const PART_BYTES = 256 * 1024;
/** Events past this are cut, with `truncated` set: a transcript is not a file store. */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
/** bridge: at most this many acked-ahead cids ride on a record (`a`); older ones fall back to the bridge's own dedupe journal. */
export const MAX_ACKED_AHEAD = 200;

const utf8 = new TextEncoder();
export const byteLength = (s: string) => utf8.encode(s).length;

/** s2's metered size: 8 + 2 per header + header names and values + body (https://s2.dev/docs/platform/limits#records). */
export function meteredBytes(r: AppendRecord) {
  let n = 8 + byteLength(r.body ?? "");
  for (const [k, v] of r.headers ?? []) n += 2 + byteLength(k) + byteLength(v);
  return n;
}

export type BridgeEvent = { bseq: number; body: string };

/** Where the bridge's command consumption stands: written on every record. */
export type Cursor = { cursor: number; ackedAhead: string[] };

const cursorHeaders = (c: Cursor): [string, string][] => [["c", String(c.cursor)], ...(c.ackedAhead.length ? ([["a", c.ackedAhead.join(",")]] as [string, string][]) : [])];

/** Splits a string into pieces of at most `max` UTF-8 bytes without cutting a code point. */
export function splitUtf8(s: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + max); // max chars is an upper bound for max bytes
    while (byteLength(s.slice(start, end)) > max) end = start + Math.floor((end - start) * 0.75);
    // never split a surrogate pair
    const code = s.charCodeAt(end - 1);
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end--;
    out.push(s.slice(start, end));
    start = end;
  }
  return out.length ? out : [""];
}

/** One event as records: a single "ev" record, or "part" records when it is bigger than PART_BYTES. */
export function encodeEvent(ev: BridgeEvent, cursor: Cursor): AppendRecord[] {
  let body = ev.body;
  if (byteLength(body) > MAX_EVENT_BYTES) {
    body = JSON.stringify({ truncated: true, bytes: byteLength(body), head: splitUtf8(body, 64 * 1024)[0] });
  }
  const base: [string, string][] = [["b", String(ev.bseq)], ...cursorHeaders(cursor)];
  if (byteLength(body) <= PART_BYTES) return [{ headers: [["k", "ev"], ...base], body }];
  const parts = splitUtf8(body, PART_BYTES);
  return parts.map((p, i) => ({ headers: [["k", "part"], ...base, ["p", `${i}/${parts.length}`]], body: p }));
}

export type Command = { seq: number; cid: string; body: string; by?: string };

/** The echo of a consumed command ("cmd"), or bridge: the answer to a call ("ret", body given). */
export function encodeCommandEcho(cmd: Command, lastBseq: number, cursor: Cursor, ret?: string): AppendRecord {
  const headers: [string, string][] = [["k", ret === undefined ? "cmd" : "ret"], ["b", String(lastBseq)], ...cursorHeaders(cursor), ["id", cmd.cid]];
  if (cmd.by && ret === undefined) headers.push(["by", cmd.by]);
  return { headers, body: ret ?? cmd.body };
}

/** bridge: client events the bridge adds itself, outside the agent's numbered lines. */
export const encodeNote = (body: string, lastBseq: number, cursor: Cursor): AppendRecord => ({ headers: [["k", "note"], ["b", String(lastBseq)], ...cursorHeaders(cursor)], body });

/** Packs records into batches within s2's batch limits, preserving order. */
export function packBatches(records: AppendRecord[]): AppendRecord[][] {
  const batches: AppendRecord[][] = [];
  let cur: AppendRecord[] = [];
  let bytes = 0;
  for (const r of records) {
    const n = meteredBytes(r);
    if (n > MAX_BATCH_BYTES) throw new Error(`record of ${n} metered bytes exceeds s2's 1 MiB`);
    if (cur.length && (cur.length >= MAX_BATCH_RECORDS || bytes + n > MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export const header = (r: { headers?: [string, string][] }, name: string) => r.headers?.find(([k]) => k === name)?.[1];

/** What the bridge needs after a restart, from the stream's last data record. */
export type Resume = { lastBseq: number } & Cursor;

/** Reads one record's resume point. A trailing incomplete event (crash between its parts) does not count as written. */
export function resumeFrom(r: SequencedRecord): Resume | null {
  if (isCommandRecord(r)) return null;
  const b = Number(header(r, "b") ?? NaN);
  const c = Number(header(r, "c") ?? NaN);
  if (!Number.isFinite(b) || !Number.isFinite(c)) return null;
  const ackedAhead = (header(r, "a") ?? "").split(",").filter(Boolean);
  if (header(r, "k") === "part") {
    const [i, n] = (header(r, "p") ?? "0/1").split("/").map(Number);
    if (i < n - 1) return { lastBseq: b - 1, cursor: c, ackedAhead };
  }
  return { lastBseq: b, cursor: c, ackedAhead };
}

export type SessionItem =
  | { kind: "event"; seq: number; bseq: number; body: string; timestamp: number }
  | { kind: "command"; seq: number; cid: string; by?: string; body: string; timestamp: number }
  /** bridge: "note" records (bseq is the last one before it) and call answers. */
  | { kind: "note"; seq: number; body: string; timestamp: number }
  | { kind: "ret"; seq: number; cid: string; body: string; timestamp: number };

/**
 * Turns records (in stream order, possibly re-read after a reconnect) into whole events and command echoes, exactly once each:
 * records at or below the last seq_num seen are ignored, events at or below the last bseq are ignored (a bridge that resent
 * after a crash), parts are joined, and a part sequence restarted from 0 (the bridge crashed mid-event) replaces the partial one.
 */
export class Assembler {
  lastSeq = -1;
  lastBseq = 0;
  private parts: { bseq: number; n: number; got: string[]; seq: number } | null = null;

  push(r: SequencedRecord): SessionItem[] {
    if (r.seq_num <= this.lastSeq) return [];
    this.lastSeq = r.seq_num;
    if (isCommandRecord(r)) return [];
    const k = header(r, "k");
    const b = Number(header(r, "b") ?? NaN);
    if (k === "cmd") {
      return [{ kind: "command", seq: r.seq_num, cid: header(r, "id") ?? "", by: header(r, "by"), body: r.body ?? "", timestamp: r.timestamp }];
    }
    if (k === "note") return [{ kind: "note", seq: r.seq_num, body: r.body ?? "", timestamp: r.timestamp }];
    if (k === "ret") return [{ kind: "ret", seq: r.seq_num, cid: header(r, "id") ?? "", body: r.body ?? "", timestamp: r.timestamp }];
    if (!Number.isFinite(b) || b <= this.lastBseq) return [];
    if (k === "ev") {
      this.parts = null;
      this.lastBseq = b;
      return [{ kind: "event", seq: r.seq_num, bseq: b, body: r.body ?? "", timestamp: r.timestamp }];
    }
    return k === "part" ? this.part(r, b) : [];
  }

  private part(r: SequencedRecord, b: number): SessionItem[] {
    const [i, n] = (header(r, "p") ?? "").split("/").map(Number);
    if (i === 0 || !this.parts || this.parts.bseq !== b) this.parts = i === 0 ? { bseq: b, n, got: [], seq: r.seq_num } : null;
    if (!this.parts || this.parts.got.length !== i) return []; // a gap: wait for the resend from part 0
    this.parts.got.push(r.body ?? "");
    if (this.parts.got.length < n) return [];
    const body = this.parts.got.join("");
    this.parts = null;
    this.lastBseq = b;
    return [{ kind: "event", seq: r.seq_num, bseq: b, body, timestamp: r.timestamp }];
  }
}
