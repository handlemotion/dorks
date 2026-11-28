import { streamSSE } from "hono/streaming";
import type { App, Change } from "../../app";
import { errBody } from "../route";
import { safeEqual, type Routes } from "./shared";
import { allPresence, openStream, validClient } from "../../services/presence";
import { listEvents } from "../../services/dorks";
import { actorOf } from "../../services/team";

/** A transcript change carries its rows when they fit: an open chat folds them in as they come, with no read of its own. */
const PUSH_ROWS = 200;
const PUSH_BYTES = 256 * 1024;

/**
 * What goes out for a change. A transcript change carries the rows from the first one it changed (`from`) on, as `GET
 * /api/dorks/:id/events?after=` would serve them, read now (so never older than the change); without them (too many, too big, the
 * dork just went away) it is an invalidation like the others, and the client reads the tail.
 */
function frame(app: App, ch: Change): object {
  if (ch.t !== "events") return ch;
  const { dorkId, seq, from } = ch;
  try {
    const page = listEvents(app, dorkId, { after: from - 1, limit: PUSH_ROWS });
    const out = { t: "events", dorkId, seq: Math.max(seq, page.events.at(-1)?.seq ?? 0), events: page.events };
    if (page.hasMore || !page.events.length || JSON.stringify(out).length > PUSH_BYTES) return { t: "events", dorkId, seq };
    return out;
  } catch {
    return { t: "events", dorkId, seq };
  }
}

// ---- live updates (Server-Sent Events): invalidations, and the rows of a transcript as it grows
export const liveRoutes: Routes = (api, app) => {
  api.get("/api/live", (c) =>
    streamSSE(c, async (stream) => {
      // `?client=<id>`: this tab or phone, for presence (services/presence.ts). Without one the stream still works, unseen.
      const client = c.req.query("client");
      const leave = validClient(client) ? openStream(app, actorOf(c), client) : undefined;
      const send = (o: object) => stream.writeSSE({ data: JSON.stringify(o) });
      let alive = true;
      // Every change is an invalidation, so a burst of the same one (a streaming answer, a dork patched field by field) is sent
      // once: one entry per distinct change (a transcript's newest seq wins), flushed at most every 50 ms. A client that reads
      // slowly gets the next batch only after the last one was written, so nothing piles up in the stream's buffer.
      const pending = new Map<string, Change>();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let writing = false;
      const flush = async () => {
        flushTimer = undefined;
        if (writing) return; // the write in progress picks the new changes up
        writing = true;
        try {
          while (alive && pending.size) {
            const batch = [...pending.values()];
            pending.clear();
            for (const ch of batch) await send(frame(app, ch));
          }
        } finally {
          writing = false;
        }
      };
      const off = app.hub.on((ch: Change) => {
        if (!alive || ch.t === "commands") return;
        const key = ch.t === "events" ? `events:${ch.dorkId}` : ch.t === "presence" ? `presence:${ch.dorkId}` : JSON.stringify(ch);
        const before = pending.get(key);
        // A burst of transcript changes goes out once, from the first row any of them wrote.
        pending.set(key, ch.t === "events" && before?.t === "events" ? { ...ch, from: Math.min(before.from, ch.from), seq: Math.max(before.seq, ch.seq) } : ch);
        flushTimer ??= setTimeout(() => void flush().catch(() => {}), 50);
      });
      stream.onAbort(() => {
        alive = false;
        off();
        leave?.();
        clearTimeout(flushTimer);
      });
      await send({ t: "hello", now: app.now() });
      for (const p of allPresence(app)) await send({ t: "presence", ...p });
      while (alive) {
        await stream.sleep(20_000);
        if (alive) await stream.write(": ping\n\n");
      }
    }),
  );
};

// ---- dev/test simulator feed (BOX_PROVIDER=sim): lets infra/bridge-sim/host.mjs start and stop fake sandboxes
export const simFeedRoutes: Routes = (api, app) => {
  api.get("/sim/boxes", (c) => {
    const key = c.req.header("x-sim-host-key");
    if (app.cfg.boxProvider !== "sim" || !app.cfg.simHostKey || !key || !safeEqual(key, app.cfg.simHostKey)) return c.json(errBody({ code: "forbidden", message: "forbidden" }), 401);
    return c.json(app.db.all("SELECT name, running, gen, bridge_port FROM sim_boxes").map((b) => ({ name: b.name, running: b.running === 1, gen: b.gen, bridgePort: b.bridge_port })));
  });
};
