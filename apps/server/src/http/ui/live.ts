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
      const tails = new Map<string, number>(); // dorkId -> newest seq, flushed at most every 50 ms
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        flushTimer = undefined;
        for (const [dorkId, seq] of tails) void send({ t: "events", dorkId, seq });
        tails.clear();
      };
      const off = app.hub.on((ch: Change) => {
        if (!alive || ch.t === "commands") return;
        if (ch.t === "events") {
          tails.set(ch.dorkId, ch.seq);
          flushTimer ??= setTimeout(flush, 50);
        } else void send(ch);
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
    return c.json(app.db.all("SELECT name, running, gen FROM sim_boxes").map((b) => ({ name: b.name, running: b.running === 1, gen: b.gen })));
  });
};
