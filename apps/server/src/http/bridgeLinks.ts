import type { App } from "../app";
import type { BridgeEndpoint } from "@dorks/core/box";
import type { DorkLocation } from "@dorks/shared";
import { BridgeSession } from "./bridgeWs";

// The server dials every awake box's bridge (docs/architecture.md, "Bridge protocol"): the owner's machine only makes outbound
// connections, through the box provider's own URL for the box (Boat's hosted port). One link per dork with a box that may be
// running; a dropped or refused socket is dialed again with backoff until the dork goes to sleep, loses its box or is deleted.

const RECONCILE_MS = 500;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** The bridge heartbeats every 30 s: a socket silent for this long is half-open, so close it and dial again. */
const SILENT_MS = 100_000;
/** Ask the provider for the endpoint again after this many failed dials in a row (the token may have changed). */
const REFRESH_AFTER = 5;

/** States in which a box may be up and its bridge must be reachable (a pause flushes through the bridge while still `idle`). */
const AWAKE = ["creating", "waking", "working", "idle"];

type Socket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};
/** A WebSocket client that takes request headers (Bun's and Node's built-in one both do, as a non-standard init option). */
export type Dial = (url: string, headers: Record<string, string>) => Socket;

const defaultDial: Dial = (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as Socket;

type Link = {
  boxId: string;
  /** The dork's location picks the provider that knows the box (docs/local-dorks.md). */
  location: DorkLocation;
  ws?: Socket;
  session?: BridgeSession;
  endpoint?: BridgeEndpoint;
  failures: number;
  lastSeen: number;
  retry?: ReturnType<typeof setTimeout>;
  ended: boolean;
};

export function startBridgeLinks(app: App, dial: Dial = defaultDial): { stop(): void } {
  const links = new Map<string, Link>();

  const end = (dorkId: string, link: Link) => {
    link.ended = true;
    clearTimeout(link.retry);
    link.session?.close();
    try {
      link.ws?.close(1000, "done");
    } catch {
      /* already closed */
    }
    links.delete(dorkId);
  };

  const again = (dorkId: string, link: Link) => {
    if (link.ended) return;
    link.failures++;
    if (link.failures % REFRESH_AFTER === 0) link.endpoint = undefined;
    const wait = Math.min(BACKOFF_START_MS * 2 ** Math.min(link.failures - 1, 10), BACKOFF_MAX_MS);
    link.retry = setTimeout(() => void connect(dorkId, link), wait);
  };

  const connect = async (dorkId: string, link: Link) => {
    if (link.ended) return;
    try {
      link.endpoint ??= await (await app.getBox(link.location)).bridgeEndpoint(link.boxId);
    } catch {
      return again(dorkId, link); // the box is not up yet, or the provider is unreachable
    }
    if (link.ended) return;
    let ws: Socket;
    try {
      ws = dial(link.endpoint.url, link.endpoint.headers);
    } catch {
      return again(dorkId, link);
    }
    link.ws = ws;
    link.lastSeen = app.now();
    ws.onopen = () => {
      if (link.ws !== ws || link.ended) return;
      const io = { send: (t: string) => ws.send(t), close: (code: number, reason?: string) => ws.close(code, reason) };
      link.session = new BridgeSession(app, io, dorkId, () => (link.failures = 0));
      link.session.open();
    };
    ws.onmessage = (m) => {
      if (link.ws !== ws) return;
      link.lastSeen = app.now();
      link.session?.onMessage(typeof m.data === "string" ? m.data : String(m.data));
    };
    ws.onerror = () => {}; // a close follows
    ws.onclose = () => {
      if (link.ws !== ws) return;
      link.session?.close();
      link.session = undefined;
      link.ws = undefined;
      again(dorkId, link);
    };
  };

  const reconcile = () => {
    let rows: { id: string; box_id: string; location: string }[];
    try {
      rows = app.db.all<{ id: string; box_id: string; location: string }>(
        `SELECT id, box_id, location FROM dorks WHERE box_id IS NOT NULL AND deleting = 0 AND state IN (${AWAKE.map(() => "?").join(", ")})`,
        ...AWAKE,
      );
    } catch {
      return; // the database is closing
    }
    const want = new Map(rows.map((r) => [r.id, r.box_id]));
    const where = new Map(rows.map((r) => [r.id, (r.location === "local" ? "local" : "cloud") as DorkLocation]));
    for (const [id, link] of links) if (want.get(id) !== link.boxId) end(id, link);
    const now = app.now();
    for (const [id, boxId] of want) {
      const link = links.get(id);
      if (!link) {
        const fresh: Link = { boxId, location: where.get(id) ?? "cloud", failures: 0, lastSeen: now, ended: false };
        links.set(id, fresh);
        void connect(id, fresh);
      } else if (link.ws && now - link.lastSeen > SILENT_MS) {
        // Half-open: a close handshake may never finish, so drop the socket now and dial again.
        const dead = link.ws;
        link.ws = undefined;
        link.session?.close();
        link.session = undefined;
        try {
          dead.close(4000, "silent");
        } catch {
          /* already closed */
        }
        again(id, link);
      }
    }
  };

  reconcile();
  const timer = setInterval(reconcile, RECONCILE_MS);
  return {
    stop() {
      clearInterval(timer);
      for (const [id, link] of links) end(id, link);
    },
  };
}
