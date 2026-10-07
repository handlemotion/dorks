import { clientEvent, type ClientEvent } from "../events";

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface StreamOptions {
  /** Fetch a single-use ticket (POST /api/dorks/:id/stream-ticket) and build the ws URL. */
  connectUrl: (after: number) => Promise<string>;
  onEvent: (e: ClientEvent) => void;
  onConnection?: (s: "connecting" | "open" | "closed") => void;
  initialAfter?: number;
  createSocket?: (url: string) => WebSocketLike;
  pingMs?: number;
  backoffMs?: (attempt: number) => number;
}

/** WebSocket with `after=` replay: reconnects forever, resumes from the last seq seen, drops duplicates, heals gaps. */
export function openDorkStream(opts: StreamOptions) {
  const create = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  const backoff = opts.backoffMs ?? ((n) => Math.min(30_000, 500 * 2 ** n));
  let last = opts.initialAfter ?? 0;
  let ws: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let attempt = 0;
  let stopped = false;
  let generation = 0;

  const scheduleReconnect = () => {
    if (stopped) return;
    clearInterval(ping);
    opts.onConnection?.("closed");
    timer = setTimeout(connect, backoff(attempt++));
  };

  async function connect() {
    if (stopped) return;
    const gen = ++generation;
    opts.onConnection?.("connecting");
    let url: string;
    try {
      url = await opts.connectUrl(last);
    } catch {
      return scheduleReconnect();
    }
    if (stopped || gen !== generation) return;
    const sock = create(url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      opts.onConnection?.("open");
      ping = setInterval(() => sock.send("ping"), opts.pingMs ?? 25_000);
    };
    sock.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data === "pong") return;
      const parsed = clientEvent.safeParse(JSON.parse(m.data));
      if (!parsed.success) return;
      const e = parsed.data;
      if (e.seq <= last) return; // duplicate
      if (e.seq !== last + 1 && last !== 0) {
        sock.close(); // gap: reconnect and replay from `last`
        return;
      }
      last = e.seq;
      opts.onEvent(e);
    };
    sock.onclose = () => {
      if (ws === sock) scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  }

  void connect();
  return {
    get lastSeq() {
      return last;
    },
    /** Call when the app returns to the foreground: reconnect now instead of waiting on backoff. */
    reconnectNow() {
      clearTimeout(timer);
      clearInterval(ping);
      const old = ws;
      ws = null;
      old?.close();
      attempt = 0;
      void connect();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    },
  };
}
