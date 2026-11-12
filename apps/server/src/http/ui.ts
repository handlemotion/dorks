import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Effect, Schema } from "effect";
import { AppFail, type App, type Change } from "../app";
import { ApiError, body, errBody, intQuery, looseBody, ok, route, service, serviceAsync, STATUS } from "./route";
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

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Request bodies. A field a service checks itself (with its own message) stays `Unknown` here.
const Loose = Schema.optional(Schema.Unknown);
const CreateDork = Schema.Struct({ repo: Loose, message: Loose, title: Loose, provider: Loose, model: Loose, effort: Loose, buildId: Loose, setup: Loose });
const Text = Schema.Struct({ text: Loose });
const Title = Schema.Struct({ title: Loose });
const Theme = Schema.Struct({ theme: Loose });
const Archived = Schema.Struct({ archived: Schema.Boolean });
const ModelChoice = Schema.Struct({ model: Loose, effort: Loose });
const Pr = Schema.Struct({ repo: Schema.String, number: Schema.Int });
const SecretValue = Schema.Struct({ value: Loose });
const Force = Schema.Struct({ force: Schema.optional(Schema.Boolean) });
const RunKind = Schema.Struct({ kind: Schema.Literals(["image", "trial"]) });
const Approve = Schema.Struct({ reviewed: Loose, run: Loose });
const Reject = Schema.Struct({ reason: Loose });
const Default = Schema.Struct({ default: Loose });

const str = (v: unknown) => v as string;

/** The loopback API the UI talks to (docs/architecture.md, "UI API"). Owner-token bearer auth on everything except /api/health. */
export function uiApp(app: App): Hono {
  const api = new Hono();
  const on = (f: Parameters<typeof route>[1]) => route(app, f);

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
    console.error("ui request failed", c.req.method, c.req.path, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return c.json(errBody({ code: "failed", message: "Something went wrong" }), 500);
  });

  const id = (c: Context) => c.req.param("id") as string;
  const name = (c: Context) => c.req.param("name") as string;

  // ---- images: an attachment for a message the owner is writing (raw bytes in the body). The message names it as dorks-image:<id>.
  api.post("/api/images", on((c) => Effect.gen(function* () {
    if (Number(c.req.header("content-length") ?? 0) > MAX_IMAGE_BYTES) return yield* ApiError.of("invalid", "the image is larger than 8 MB");
    const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
    return c.json(yield* service((a) => uploadImage(a, bytes)), 201);
  })));

  // ---- dorks
  api.get("/api/dorks", on((c) => service((a) => c.json(listDorks(a, c.req.query("archived") === "true")))));
  api.post("/api/dorks", on((c) => Effect.gen(function* () {
    const b = yield* body(c, CreateDork);
    const dorkId = yield* service((a) => createDork(a, { repo: b.repo as string | undefined, message: str(b.message), title: b.title as string | undefined, provider: b.provider as never, model: b.model, effort: b.effort, buildId: b.buildId, setup: b.setup }));
    return c.json({ id: dorkId }, 201);
  })));
  api.get("/api/dorks/:id", on((c) => service((a) => getDorkView(a, id(c))).pipe(
    Effect.flatMap((d) => (d ? Effect.succeed(c.json(d)) : Effect.fail(ApiError.of("not_found", "not found")))),
  )));
  api.patch("/api/dorks/:id", on((c) => body(c, Title).pipe(Effect.flatMap((b) => service((a) => renameDork(a, id(c), str(b.title)))), ok(c))));
  api.delete("/api/dorks/:id", on((c) => ok(c)(service((a) => removeDork(a, id(c))))));
  api.post("/api/dorks/:id/messages", on((c) => body(c, Text).pipe(Effect.flatMap((b) => service((a) => sendMessage(a, id(c), str(b.text)))), ok(c))));
  api.post("/api/dorks/:id/interrupt", on((c) => ok(c)(service((a) => interrupt(a, id(c))))));
  api.post("/api/dorks/:id/desktop", on((c) => Effect.gen(function* () {
    const b = yield* body(c, Theme);
    const url = yield* serviceAsync((a) => desktopUrl(a, id(c), { theme: b.theme === "dark" ? "dark" : "light" }));
    c.header("Cache-Control", "no-store");
    return c.json({ url });
  })));
  api.post("/api/dorks/:id/archive", on((c) => body(c, Archived, "archived must be a boolean").pipe(Effect.flatMap((b) => service((a) => setArchived(a, id(c), b.archived))), ok(c))));
  api.post("/api/dorks/:id/model", on((c) => body(c, ModelChoice).pipe(Effect.flatMap((b) => service((a) => chooseModel(a, id(c), b.model, b.effort))), ok(c))));
  api.post("/api/dorks/:id/codex-model", on((c) => body(c, ModelChoice).pipe(Effect.flatMap((b) => service((a) => chooseCodexModel(a, id(c), str(b.model), str(b.effort)))), ok(c))));
  api.get("/api/dorks/:id/events", on((c) => Effect.gen(function* () {
    const q = { before: yield* intQuery(c, "before"), after: yield* intQuery(c, "after"), limit: yield* intQuery(c, "limit") };
    return c.json(yield* service((a) => listEvents(a, id(c), q)));
  })));

  // ---- PR subscriptions
  const pr = (c: Context) => body(c, Pr, "repo and number are required");
  api.get("/api/dorks/:id/subscriptions", on((c) => service((a) => c.json(getDorkView(a, id(c)) ? subs.liveSubscriptionViews(a, id(c)) : []))));
  api.post("/api/dorks/:id/subscriptions", on((c) => pr(c).pipe(
    Effect.flatMap(({ repo, number }) => service((a) => a.db.tx(() => void subs.subscribe(a, owned(a, id(c)), repo, number, "user")))),
    ok(c),
  )));
  api.delete("/api/dorks/:id/subscriptions", on((c) => pr(c).pipe(
    Effect.flatMap(({ repo, number }) => service((a) => a.db.tx(() => {
      owned(a, id(c));
      subs.unsubscribe(a, id(c), repo, number);
    }))),
    ok(c),
  )));
  api.post("/api/dorks/:id/subscriptions/resume", on((c) => pr(c).pipe(
    Effect.flatMap(({ repo, number }) => service((a) => a.db.tx(() => subs.resume(a, owned(a, id(c)), repo, number)))),
    ok(c),
  )));

  // ---- settings and secrets
  api.get("/api/settings", on((c) => service((a) => c.json(settingsView(a)))));
  api.put("/api/settings", on((c) => Effect.gen(function* () {
    const patch = yield* looseBody(c);
    // Provider values are checked here, by the server, before anything is saved (GitHub's is checked inside updateSettings).
    yield* serviceAsync((a) => assertBoatAccepts(a, patch));
    yield* serviceAsync((a) => assertCodexEnvironment(a, patch));
    yield* serviceAsync((a) => updateSettings(a, patch));
    yield* service((a) => {
      if ("claudeToken" in patch || "boatKey" in patch || "boatOrg" in patch) forgetUsage(a);
      console.error(`settings saved: ${Object.keys(patch).sort().join(", ")}`); // names only, never values
      // A new Boat key starts the base-snapshot build in the background (onboarding has no "Prepare Boat" step), or retries a failed one.
      if (typeof patch.boatKey === "string" && patch.boatKey.trim()) buildIfMissing(a, { retryFailed: true });
    });
    return c.json({});
  })));
  api.get("/api/secrets", on((c) => service((a) => c.json(secretNames(a)))));
  api.put("/api/secrets/:name", on((c) => body(c, SecretValue).pipe(Effect.flatMap((b) => serviceAsync((a) => setSecret(a, name(c), str(b.value)))), ok(c))));
  api.delete("/api/secrets/:name", on((c) => ok(c)(service((a) => deleteSecret(a, name(c))))));

  // ---- usage of the Claude subscription and Boat plan (services/usage.ts), cached for five minutes
  api.get("/api/usage", on((c) => serviceAsync(getUsage).pipe(Effect.map((u) => c.json(u)))));

  // ---- Boat key check (nothing is saved)
  api.post("/api/boat/check", on((c) => looseBody(c).pipe(Effect.flatMap((b) => serviceAsync((a) => checkBoat(a, b))), Effect.map((r) => c.json(r)))));

  // ---- base snapshot ("Prepare Boat")
  api.get("/api/snapshot", on((c) => serviceAsync(snapshotView).pipe(Effect.map((v) => c.json(v)))));
  api.post("/api/snapshot/build", on((c) => body(c, Force, "force must be a boolean").pipe(
    Effect.flatMap((b) => serviceAsync((a) => startBuild(a, { force: b.force === true }))),
    Effect.map((v) => c.json(v, 202)),
  )));

  // ---- builds (docs/builds.md)
  const runId = (c: Context) => c.req.param("runId") as string;
  const draftId = (c: Context) => c.req.param("draftId") as string;
  api.get("/api/builds", on((c) => serviceAsync(builds.listBuilds).pipe(Effect.map((v) => c.json(v)))));
  api.post("/api/builds", on((c) => looseBody(c).pipe(Effect.flatMap((b) => service((a) => builds.createBuild(a, b))), Effect.map((buildId) => c.json({ id: buildId }, 201)))));
  api.get("/api/builds/:id", on((c) => serviceAsync((a) => builds.buildView(a, builds.ownBuild(a, id(c)))).pipe(Effect.map((v) => c.json(v)))));
  api.patch("/api/builds/:id", on((c) => looseBody(c).pipe(Effect.flatMap((b) => service((a) => builds.updateBuild(a, id(c), b))), ok(c))));
  api.delete("/api/builds/:id", on((c) => ok(c)(service((a) => builds.deleteBuild(a, id(c))))));
  api.put("/api/builds/:id/default", on((c) => body(c, Default).pipe(Effect.flatMap((b) => service((a) => builds.setDefaultBuild(a, b.default === false ? null : id(c)))), ok(c))));
  api.put("/api/builds/:id/vars/:name", on((c) => looseBody(c).pipe(Effect.flatMap((b) => serviceAsync((a) => builds.setBuildVar(a, id(c), name(c), b))), ok(c))));
  api.delete("/api/builds/:id/vars/:name", on((c) => ok(c)(service((a) => builds.deleteBuildVar(a, id(c), name(c))))));
  api.get("/api/builds/:id/runs", on((c) => service((a) => c.json(builds.listRuns(a, id(c))))));
  api.post("/api/builds/:id/runs", on((c) => body(c, RunKind, "kind must be image or trial").pipe(
    Effect.flatMap(({ kind }) => service((a) => runs.startRun(a, id(c), { kind, by: "owner" }))),
    Effect.map((run) => c.json(run, 202)),
  )));
  api.get("/api/builds/:id/runs/:runId/log", on((c) => intQuery(c, "after").pipe(Effect.flatMap((after) => service((a) => c.json(runs.runLog(a, id(c), runId(c), after ?? 0)))))));
  api.post("/api/builds/:id/runs/:runId/cancel", on((c) => ok(c)(service((a) => runs.cancelRun(a, id(c), runId(c))))));
  api.post("/api/builds/:id/drafts/:draftId/approve", on((c) => Effect.gen(function* () {
    const b = yield* body(c, Approve);
    const { missing } = yield* serviceAsync((a) => builds.approveDraft(a, id(c), draftId(c), b.reviewed));
    // Build right away unless the owner said not to, or a value the setup needs is still missing (the owner fills it in, then builds).
    const run = b.run !== false && !missing.length ? yield* service((a) => runs.startRun(a, id(c), { kind: "image", by: "owner" })) : null;
    return c.json({ run, missing });
  })));
  api.post("/api/builds/:id/drafts/:draftId/reject", on((c) => body(c, Reject).pipe(Effect.flatMap((b) => service((a) => builds.rejectDraft(a, id(c), draftId(c), b.reason))), ok(c))));

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
