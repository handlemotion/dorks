import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { AppFail, type App, type Change } from "../app";
import { z } from "zod";
import type { AppError } from "@dorks/shared";
import { imageBytes, MAX_IMAGE_BYTES, uploadImage } from "../services/bridge";
import { chooseCodexModel, createDork, desktopUrl, getDorkView, interrupt, listDorks, listEvents, removeDork, renameDork, sendMessage, setArchived, owned } from "../services/dorks";
import { chooseModel } from "../services/models";
import { deleteSecret, secretNames, setSecret, settingsView, updateSettings } from "../services/settings";
import { assertBoatAccepts, assertCodexEnvironment, checkBoat } from "../services/boatCheck";
import { buildIfMissing, snapshotView, startBuild } from "../services/snapshot";
import * as subs from "../services/subscriptions";
import * as builds from "../services/builds";
import * as runs from "../services/buildRuns";
import { forgetUsage, getUsage } from "../services/usage";

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

  // The simulator's stand-in for a Boat desktop stream (lib/box.ts simBox): a static page, no data, so it needs no token.
  if (app.cfg.boxProvider === "sim") api.get("/sim/desktop", (c) => c.html(simDesktopPage(c.req.query("theme") === "dark")));

  // A screenshot the agent shared (screenshot_share). Outside /api so a plain <img> can load it: the 128-bit random id is the
  // capability, handed out only inside the owner's transcript. Immutable, never sniffed, never run as a document.
  api.get("/images/:id", (c) => {
    const img = imageBytes(app, c.req.param("id"));
    if (!img) return c.json(errBody({ code: "not_found", message: "not found" }), 404);
    return new Response(img.bytes, {
      headers: {
        "content-type": img.mime,
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });

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

  // ---- images: an attachment for a message the owner is writing (raw bytes in the body). The message names it as dorks-image:<id>.
  api.post("/api/images", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) throw new AppFail({ code: "invalid", message: "the image is larger than 8 MB" });
    return c.json(uploadImage(app, new Uint8Array(await c.req.arrayBuffer())), 201);
  });

  // ---- dorks
  api.get("/api/dorks", (c) => c.json(listDorks(app, c.req.query("archived") === "true")));
  api.post("/api/dorks", async (c) => {
    const b = await body(c);
    const id = createDork(app, { repo: b.repo as string | undefined, message: b.message as string, title: b.title as string | undefined, provider: b.provider as never, model: b.model, effort: b.effort, buildId: b.buildId, setup: b.setup });
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
  api.post("/api/dorks/:id/desktop", async (c) => {
    const b = await body(c);
    const theme = b.theme === "dark" ? "dark" : "light";
    const url = await desktopUrl(app, dorkIdOf(c), { theme });
    c.header("Cache-Control", "no-store");
    return c.json({ url });
  });
  api.post("/api/dorks/:id/archive", async (c) => {
    const b = await body(c);
    if (typeof b.archived !== "boolean") throw new AppFail({ code: "invalid", message: "archived must be a boolean" });
    setArchived(app, dorkIdOf(c), b.archived);
    return c.json({});
  });
  api.post("/api/dorks/:id/model", async (c) => {
    const b = await body(c);
    chooseModel(app, dorkIdOf(c), b.model, b.effort);
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
    if ("claudeToken" in patch || "boatKey" in patch || "boatOrg" in patch) forgetUsage(app);
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

  // ---- usage of the Claude subscription and Boat plan (services/usage.ts), cached for five minutes
  api.get("/api/usage", async (c) => c.json(await getUsage(app)));

  // ---- Boat key check (nothing is saved)
  api.post("/api/boat/check", async (c) => c.json(await checkBoat(app, await body(c))));

  // ---- base snapshot ("Prepare Boat")
  api.get("/api/snapshot", async (c) => c.json(await snapshotView(app)));
  api.post("/api/snapshot/build", async (c) => {
    const b = await body(c);
    if (b.force !== undefined && typeof b.force !== "boolean") throw new AppFail({ code: "invalid", message: "force must be a boolean" });
    return c.json(await startBuild(app, { force: b.force === true }), 202);
  });

  // ---- builds (docs/builds.md)
  const buildIdOf = (c: Context) => c.req.param("id") as string;
  api.get("/api/builds", async (c) => c.json(await builds.listBuilds(app)));
  api.post("/api/builds", async (c) => c.json({ id: builds.createBuild(app, await body(c)) }, 201));
  api.get("/api/builds/:id", async (c) => c.json(await builds.buildView(app, builds.ownBuild(app, buildIdOf(c)))));
  api.patch("/api/builds/:id", async (c) => {
    builds.updateBuild(app, buildIdOf(c), await body(c));
    return c.json({});
  });
  api.delete("/api/builds/:id", (c) => {
    builds.deleteBuild(app, buildIdOf(c));
    return c.json({});
  });
  api.put("/api/builds/:id/default", async (c) => {
    const b = await body(c);
    builds.setDefaultBuild(app, b.default === false ? null : buildIdOf(c));
    return c.json({});
  });
  api.put("/api/builds/:id/vars/:name", async (c) => {
    await builds.setBuildVar(app, buildIdOf(c), c.req.param("name"), await body(c));
    return c.json({});
  });
  api.delete("/api/builds/:id/vars/:name", (c) => {
    builds.deleteBuildVar(app, buildIdOf(c), c.req.param("name"));
    return c.json({});
  });
  api.get("/api/builds/:id/runs", (c) => c.json(builds.listRuns(app, buildIdOf(c))));
  api.post("/api/builds/:id/runs", async (c) => {
    const b = await body(c);
    if (b.kind !== "image" && b.kind !== "trial") throw new AppFail({ code: "invalid", message: "kind must be image or trial" });
    return c.json(runs.startRun(app, buildIdOf(c), { kind: b.kind, by: "owner" }), 202);
  });
  api.get("/api/builds/:id/runs/:runId/log", (c) => c.json(runs.runLog(app, buildIdOf(c), c.req.param("runId"), intParam(c.req.query("after")) ?? 0)));
  api.post("/api/builds/:id/runs/:runId/cancel", (c) => {
    runs.cancelRun(app, buildIdOf(c), c.req.param("runId"));
    return c.json({});
  });
  api.post("/api/builds/:id/drafts/:draftId/approve", async (c) => {
    const b = await body(c);
    const { missing } = await builds.approveDraft(app, buildIdOf(c), c.req.param("draftId"));
    // Build right away unless the owner said not to, or a value the setup needs is still missing (the owner fills it in, then builds).
    const run = b.run !== false && !missing.length ? runs.startRun(app, buildIdOf(c), { kind: "image", by: "owner" }) : null;
    return c.json({ run, missing });
  });
  api.post("/api/builds/:id/drafts/:draftId/reject", async (c) => {
    builds.rejectDraft(app, buildIdOf(c), c.req.param("draftId"), (await body(c)).reason);
    return c.json({});
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

function simDesktopPage(dark: boolean): string {
  const [bg, fg, bar] = dark ? ["#1d1f24", "#e6e6e6", "#2a2d33"] : ["#3a6ea5", "#1a1a1a", "#f2f2f2"];
  const window = `<div style="position:absolute;inset:8% 12% 14% 10%;background:#fff;border-radius:8px;overflow:hidden">
<div style="height:36px;background:${bar};display:flex;align-items:center;padding:0 12px;font:13px system-ui;color:${fg}">localhost:3000</div>
<div style="padding:32px;font:15px system-ui;color:#1a1a1a">Simulated sandbox screen. A real dork streams its Boat desktop here.</div></div>`;
  return `<!doctype html><meta charset="utf-8"><title>Simulated desktop</title><body style="margin:0;height:100vh;background:${bg};position:relative;overflow:hidden">${window}</body>`;
}
