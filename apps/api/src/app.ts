import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "./auth";
import type { Reply } from "./dork";
import { missingOnboarding } from "./lifecycle/deps";
import { createMailer, type Mailer } from "./lib/mailer";

type AuthSession = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>>;
export type AppEnv = { Bindings: Env; Variables: { user: AuthSession["user"]; session: AuthSession["session"] } };

const createBody = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  message: z.string().trim().min(1).max(50_000),
  title: z.string().trim().min(1).max(120).optional(),
});
const patchBody = z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }).refine((b) => b.title !== undefined || b.archived !== undefined);
const messageBody = z.object({ text: z.string().trim().min(1).max(50_000) });

const DORK_COLUMNS = "id, title, repo_full_name, branch, status, archived_at, last_preview, pr_url, created_at, last_activity_at";

export function createApp(deps: { mailer?: (env: Env) => Mailer } = {}) {
  const app = new Hono<AppEnv>();
  const auth = (env: Env, ctx: Pick<ExecutionContext, "waitUntil">) => createAuth(env, ctx, (deps.mailer ?? createMailer)(env));
  const dorkStub = (env: Env, id: string) => env.DORK.get(env.DORK.idFromName(id));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth(c.env, c.executionCtx).handler(c.req.raw));

  // The in-box bridge dials in here; the DO checks its per-box bearer secret.
  app.get("/api/bridge/:id", (c) => dorkStub(c.env, c.req.param("id")).fetch(new Request("http://do/bridge", c.req.raw)));

  // WebSocket auth is a single-use ticket (below) so web and native share one path; the DO validates it.
  app.get("/api/dorks/:id/stream", (c) => dorkStub(c.env, c.req.param("id")).fetch(c.req.raw));

  // Everything below requires a session. Webhooks (added later) are mounted above this line.
  app.use("/api/*", async (c, next) => {
    const s = await auth(c.env, c.executionCtx).api.getSession({ headers: c.req.raw.headers });
    if (!s) return c.json({ error: "unauthorized" }, 401);
    c.set("user", s.user);
    c.set("session", s.session);
    await next();
  });

  app.get("/api/me", (c) => c.json({ user: { id: c.var.user.id, email: c.var.user.email } }));

  // ---- dorks. Every route checks ownership in D1 before touching the dork's Durable Object. ----
  const load = (c: { env: Env; var: { user: { id: string } } }, id: string) =>
    c.env.DB.prepare(`SELECT ${DORK_COLUMNS} FROM dorks WHERE id = ? AND user_id = ?`).bind(id, c.var.user.id).first();

  // Turns a failed DO Reply into an HTTP response; returns null when ok.
  const reject = (c: { json: (b: unknown, s: 400 | 404 | 409 | 500) => Response }, r: Reply<unknown>) => {
    if (r.ok) return null;
    const status = r.code === "archived" || r.code === "conflict" || r.code === "deleting" ? 409 : r.code === "invalid" ? 400 : 500;
    return c.json({ error: r.message, code: r.code }, status);
  };

  app.get("/api/dorks", async (c) => {
    const archived = c.req.query("archived") === "1";
    const rows = await c.env.DB.prepare(`SELECT ${DORK_COLUMNS} FROM dorks WHERE user_id = ? AND (archived_at IS NOT NULL) = ? ORDER BY last_activity_at DESC LIMIT 200`)
      .bind(c.var.user.id, archived ? 1 : 0).all();
    return c.json({ dorks: rows.results });
  });

  app.post("/api/dorks", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues.map((i) => i.message) }, 400);
    const missing = await missingOnboarding(c.env, c.var.user.id);
    if (missing.length) return c.json({ error: "onboarding_incomplete", missing }, 409);

    const id = crypto.randomUUID();
    const branch = `agent/${id.slice(0, 8)}`;
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO dorks (id, user_id, title, repo_full_name, branch, status, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)")
      .bind(id, c.var.user.id, body.data.title ?? body.data.message.slice(0, 60), body.data.repo, branch, now, now).run();
    const stub = dorkStub(c.env, id);
    const initR = await stub.init({ dorkId: id, userId: c.var.user.id, repo: body.data.repo, branch, bridgeSecret: crypto.randomUUID() + crypto.randomUUID() });
    if (!initR.ok) return reject(c, initR)!;
    const created = await stub.create(body.data.message); // box failures land in `error` state; the row exists either way
    if (!created.ok) return reject(c, created)!;
    return c.json({ dork: await load(c, id) }, 201);
  });

  app.get("/api/dorks/:id", async (c) => {
    const row = await load(c, c.req.param("id"));
    return row ? c.json({ dork: row }) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/dorks/:id", async (c) => {
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (!(await load(c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    if (body.data.archived !== undefined) {
      const r = await dorkStub(c.env, c.req.param("id")).setArchived(body.data.archived);
      if (!r.ok) return reject(c, r)!;
    }
    if (body.data.title) await c.env.DB.prepare("UPDATE dorks SET title = ? WHERE id = ?").bind(body.data.title, c.req.param("id")).run();
    return c.json({ dork: await load(c, c.req.param("id")) });
  });

  app.delete("/api/dorks/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await load(c, id))) return c.json({ error: "not found" }, 404);
    const r = await dorkStub(c.env, id).destroy(); // fails if the box could not be deleted: row stays, caller retries
    if (!r.ok) return reject(c, r)!;
    await c.env.DB.prepare("DELETE FROM dorks WHERE id = ? AND user_id = ?").bind(id, c.var.user.id).run();
    return c.json({ ok: true });
  });

  app.post("/api/dorks/:id/messages", async (c) => {
    const body = messageBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (!(await load(c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const r = await dorkStub(c.env, c.req.param("id")).sendMessage(body.data.text);
    return reject(c, r) ?? c.json({ status: (r as { value: unknown }).value }, 202);
  });

  app.post("/api/dorks/:id/interrupt", async (c) => {
    if (!(await load(c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const r = await dorkStub(c.env, c.req.param("id")).interrupt();
    return reject(c, r) ?? c.json({ status: (r as { value: unknown }).value });
  });

  app.post("/api/dorks/:id/stream-ticket", async (c) => {
    if (!(await load(c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    return c.json({ ticket: await dorkStub(c.env, c.req.param("id")).issueTicket() });
  });

  return app;
}
