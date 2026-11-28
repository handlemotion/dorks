import type { LiveMessage } from "./types.ts";

export type LiveStatus = "connecting" | "live" | "offline" | "unauthorized";

export interface LiveOptions {
  baseUrl: string;
  token: string;
  /** This tab's or phone's id, for presence (docs/cloud.md). */
  client?: string;
  fetch?: typeof fetch;
  onMessage: (m: LiveMessage) => void;
  onStatus: (s: LiveStatus) => void;
  /** Reconnect delay in ms for the nth consecutive failure (0-based). Default: 500ms doubling up to 10s. */
  backoff?: (attempt: number) => number;
  /** How long a connected stream may stay silent before it is dropped and dialed again (default `LIVE_SILENT_MS`). */
  silentMs?: number;
}

const defaultBackoff = (n: number) => Math.min(10_000, 500 * 2 ** n);

/**
 * The server pings an idle stream every 20 s (`/api/live`), so one silent for this long is dead even if no error says so (a socket
 * a sleeping Mac or a webview left half-open): it is dropped and dialed again, and the `hello` that follows resyncs what was missed.
 */
export const LIVE_SILENT_MS = 45_000;

/** Splits an SSE byte stream into `data:` payloads. Comment lines (`: ping`) are ignored. */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buf = "";
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    for (;;) {
      const m = /\r\n|\n|\r/.exec(buf);
      if (!m) return;
      // A lone "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
      if (m[0] === "\r" && m.index === buf.length - 1) return;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === "") {
        if (data.length) onData(data.join("\n"));
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  };
}

/**
 * One SSE connection to `/api/live` over fetch (so the owner token travels in a header and it works the same in a browser,
 * a Tauri webview and Node), reconnecting with backoff. Every (re)connect begins with a `hello`, which consumers treat as
 * "refetch what you show". Returns a function that closes it.
 */
export function connectLive(opts: LiveOptions): () => void {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const backoff = opts.backoff ?? defaultBackoff;
  const base = opts.baseUrl.replace(/\/+$/, "");
  let stopped = false;
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let heard = 0;
  const silentMs = opts.silentMs ?? LIVE_SILENT_MS;
  // Checked on a timer, not per read: a dead stream never returns from its read.
  const watchdog = setInterval(
    () => {
      if (heard && Date.now() - heard > silentMs) {
        heard = 0;
        abort?.abort(); // the read throws, and run() dials again
      }
    },
    Math.min(5_000, silentMs / 3),
  );

  const retry = () => {
    if (stopped) return;
    opts.onStatus("offline");
    timer = setTimeout(() => void run(), backoff(attempt++));
  };

  async function run() {
    if (stopped) return;
    abort = new AbortController();
    opts.onStatus("connecting");
    heard = Date.now(); // a dial that never answers is dropped like a silent stream
    try {
      const res = await doFetch(`${base}/api/live${opts.client ? `?client=${encodeURIComponent(opts.client)}` : ""}`, {
        headers: { authorization: `Bearer ${opts.token}`, accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (res.status === 401) {
        opts.onStatus("unauthorized");
        return; // a wrong token never fixes itself; the app has to ask for a new one
      }
      if (!res.ok || !res.body) return retry();
      heard = Date.now();
      const parse = createSseParser((d) => {
        let m: LiveMessage;
        try {
          m = JSON.parse(d) as LiveMessage;
        } catch {
          return; // a malformed message is dropped; the next hello resynchronizes everything
        }
        if (m.t === "hello") {
          attempt = 0;
          opts.onStatus("live");
        }
        opts.onMessage(m);
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        heard = Date.now();
        parse(decoder.decode(value, { stream: true }));
      }
      heard = 0;
      retry();
    } catch {
      heard = 0;
      retry();
    }
  }

  void run();
  return () => {
    stopped = true;
    clearInterval(watchdog);
    if (timer) clearTimeout(timer);
    abort?.abort();
  };
}
