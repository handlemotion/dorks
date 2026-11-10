import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { AppFail, type App, type Change } from "../app";
import { z } from "zod";
import type { AppError } from "@dorks/shared";
import { chooseCodexModel, createDork, getDorkView, interrupt, listDorks, listEvents, removeDork, renameDork, sendMessage, setArchived, owned } from "../services/dorks";
import { deleteSecret, secretNames, setSecret, settingsView, updateSettings } from "../services/settings";
import { assertBoatAccepts, assertCodexEnvironment, checkBoat } from "../services/boatCheck";
import { buildIfMissing, snapshotView, startBuild } from "../services/snapshot";
import * as subs from "../services/subscriptions";

const STATUS: Record<AppError["code"], number> = {
  invalid: 400, not_found: 404, forbidden: 401, limit: 429, rate_limited: 429, archived: 409, deleting: 409, conflict: 409, sleeping: 409,
  onboarding_incomplete: 412, not_configured: 412, too_many_frames: 413, event_too_large: 413, github_error: 502, timeout: 504, turn_failed: 500, failed: 500,
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const errBody = (error: AppError) => ({ error });

/** The loopback API the UI talks to (docs/architecture.md, "UI API"). Owner-token bearer auth on everything except /api/health. */
export function uiApp(app: App): Hono {
  const api = new Hono();

  api.use("*", cors({ origin: (origin) => (app.cfg.uiOrigins.includes(origin) ? origin : null), allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], maxAge: 600 }));

  api.get("/api/health", (c) => c.json({ ok: true }));

  api.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const header = c.req.header("authorization");
    const presented = header?.startsWith("Bearer ") ? header.slice(7) : c.req.path === "/api/live" ? c.req.query("access_token") : undefined;
    if (!presented || !safeEqual(presented, app.cfg.ownerToken)) return c.json(errBody({ code: "forbidden", message: "forbidden" }), 401);
    return next();
  });

  api.onError((e, c) => {
    if (e instanceof AppFail) return c.json(errBody(e.error), STATUS[e.error.code] as 400);
    if (e instanceof SyntaxError) return c.json(errBody({ code: "invalid", message: "bad JSON" }), 400);
    console.error("ui request failed", c.req.method, c.req.path, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return c.json(errBody({ code: "failed", message: "Something went wrong" }), 500);
  });

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text) return {};
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AppFail({ code: "invalid", message: "body must be an object" });
    return v as Record<string, unknown>;
  };
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const intParam = (v: string | undefined) => {
    const n = num(v);
    if (n !== undefined && !Number.isFinite(n)) throw new AppFail({ code: "invalid", message: "bad number" });
    return n;
  };
  const dorkIdOf = (c: Context) => c.req.param("id") as string;

  // ---- dorks
  api.get("/api/dorks", (c) => c.json(listDorks(app, c.req.query("archived") === "true")));
  api.post("/api/dorks", async (c) => {
    const b = await body(c);
    const id = createDork(app, { repo: b.repo as string, message: b.message as string, title: b.title as string | undefined, provider: b.provider as never });
    return c.json({ id }, 201);
  });
  api.get("/api/dorks/:id", (c) => {
    const d = getDorkView(app, dorkIdOf(c));
    return d ? c.json(d) : c.json(errBody({ code: "not_found", message: "not found" }), 404);
  });
  api.patch("/api/dorks/:id", async (c) => {
    renameDork(app, dorkIdOf(c), (await body(c)).title as string);
    return c.json({});
  });
  api.delete("/api/dorks/:id", (c) => {
    removeDork(app, dorkIdOf(c));
    return c.json({});
  });
  api.post("/api/dorks/:id/messages", async (c) => {
    sendMessage(app, dorkIdOf(c), (await body(c)).text as string);
    return c.json({});
  });
  api.post("/api/dorks/:id/interrupt", (c) => {
    interrupt(app, dorkIdOf(c));
    return c.json({});
  });
  api.post("/api/dorks/:id/archive", async (c) => {
    const b = await body(c);
    if (typeof b.archived !== "boolean") throw new AppFail({ code: "invalid", message: "archived must be a boolean" });
    setArchived(app, dorkIdOf(c), b.archived);
    return c.json({});
  });
  api.post("/api/dorks/:id/codex-model", async (c) => {
    const b = await body(c);
    chooseCodexModel(app, dorkIdOf(c), b.model as string, b.effort as string);
    return c.json({});
  });
  api.get("/api/dorks/:id/events", (c) => {
    const q = { before: intParam(c.req.query("before")), after: intParam(c.req.query("after")), limit: intParam(c.req.query("limit")) };
    return c.json(listEvents(app, dorkIdOf(c), q));
  });

  // ---- PR subscriptions
  const prArgs = z.object({ repo: z.string(), number: z.number().int() });
  const pr = async (c: Context) => {
    const parsed = prArgs.safeParse(await body(c));
    if (!parsed.success) throw new AppFail({ code: "invalid", message: "repo and number are required" });
    return parsed.data;
  };
  api.get("/api/dorks/:id/subscriptions", (c) => {
    if (!getDorkView(app, dorkIdOf(c))) return c.json([]);
    return c.json(subs.liveSubscriptionViews(app, dorkIdOf(c)));
  });
  api.post("/api/dorks/:id/subscriptions", async (c) => {
    const { repo, number } = await pr(c);
    app.db.tx(() => void subs.subscribe(app, owned(app, dorkIdOf(c)), repo, number, "user"));
    return c.json({});
  });
  api.delete("/api/dorks/:id/subscriptions", async (c) => {
    const { repo, number } = await pr(c);
    app.db.tx(() => {
      owned(app, dorkIdOf(c));
      subs.unsubscribe(app, dorkIdOf(c), repo, number);
    });
    return c.json({});
  });
  api.post("/api/dorks/:id/subscriptions/resume", async (c) => {
    const { repo, number } = await pr(c);
    app.db.tx(() => subs.resume(app, owned(app, dorkIdOf(c)), repo, number));
    return c.json({});
  });

  // ---- settings and secrets
  api.get("/api/settings", (c) => c.json(settingsView(app)));
  api.put("/api/settings", async (c) => {
    const patch = await body(c);
    // Provider values are checked here, by the server, before anything is saved (GitHub's is checked inside updateSettings).
    await assertBoatAccepts(app, patch);
    await assertCodexEnvironment(app, patch);
    await updateSettings(app, patch);
    console.error(`settings saved: ${Object.keys(patch).sort().join(", ")}`); // names only, never values
    // A new Boat key starts the base-snapshot build in the background (onboarding has no "Prepare Boat" step), or retries a failed one.
    if (typeof patch.boatKey === "string" && patch.boatKey.trim()) buildIfMissing(app, { retryFailed: true });
    return c.json({});
  });
  api.get("/api/secrets", (c) => c.json(secretNames(app)));
  api.put("/api/secrets/:name", async (c) => {
    await setSecret(app, c.req.param("name"), (await body(c)).value as string);
    return c.json({});
  });
  api.delete("/api/secrets/:name", (c) => {
    deleteSecret(app, c.req.param("name"));
    return c.json({});
  });

  // ---- Boat key check (nothing is saved)
  api.post("/api/boat/check", async (c) => c.json(await checkBoat(app, await body(c))));

  // ---- base snapshot ("Prepare Boat")
  api.get("/api/snapshot", async (c) => c.json(await snapshotView(app)));
  api.post("/api/snapshot/build", async (c) => {
    const b = await body(c);
    if (b.force !== undefined && typeof b.force !== "boolean") throw new AppFail({ code: "invalid", message: "force must be a boolean" });
    return c.json(await startBuild(app, { force: b.force === true }), 202);
  });

  // ---- live updates (Server-Sent Events): invalidations, not payloads
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

  // ---- dev/test simulator feed (BOX_PROVIDER=sim): lets infra/bridge-sim/host.mjs start and stop fake sandboxes
  api.get("/sim/boxes", (c) => {
    const key = c.req.header("x-sim-host-key");
    if (app.cfg.boxProvider !== "sim" || !app.cfg.simHostKey || !key || !safeEqual(key, app.cfg.simHostKey)) return c.json(errBody({ code: "forbidden", message: "forbidden" }), 401);
    return c.json(app.db.all("SELECT name, running, gen FROM sim_boxes").map((b) => ({ name: b.name, running: b.running === 1, gen: b.gen })));
  });

  return api;
}
