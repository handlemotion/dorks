import { streamSSE } from "hono/streaming";
import type { Change } from "../../app";
import { errBody } from "../route";
import { safeEqual, type Routes } from "./shared";

// ---- live updates (Server-Sent Events): invalidations, not payloads
export const liveRoutes: Routes = (api, app) => {
  api.get("/api/live", (c) =>
    streamSSE(c, async (stream) => {
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
            for (const ch of batch) await send(ch);
          }
        } finally {
          writing = false;
        }
      };
      const off = app.hub.on((ch: Change) => {
        if (!alive || ch.t === "commands") return;
        pending.set(ch.t === "events" ? `events:${ch.dorkId}` : JSON.stringify(ch), ch);
        flushTimer ??= setTimeout(() => void flush().catch(() => {}), 50);
      });
      stream.onAbort(() => {
        alive = false;
        off();
        clearTimeout(flushTimer);
      });
      await send({ t: "hello", now: app.now() });
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
