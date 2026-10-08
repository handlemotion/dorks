import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { aad, encrypt, keyringFromEnv } from "../src/lib/crypto";
import { call, signIn } from "./helpers";

const sent: Record<string, string> = {};
const app = createApp({ mailer: () => ({ async sendOtp(to, code) { sent[to] = code; } }) });
const json = (res: Response) => res.json() as Promise<any>;

async function onboard(userId: string) {
  const enc = await encrypt(keyringFromEnv(env), "sk-ant-oat01-xyz", aad.claudeToken(userId));
  await env.DB.prepare("INSERT INTO user_settings (user_id, claude_token_enc, github_installation_id, key_version) VALUES (?, ?, 123, ?)").bind(userId, enc.value, enc.keyVersion).run();
}

describe("dorks API", () => {
  let alice: { cookie: string; userId: string };
  let bob: { cookie: string; userId: string };
  beforeAll(async () => {
    (env as any).BOX_PROVIDER = "sim"; // in-memory box
    (env as any).BASE_SNAPSHOT_ID = "snap-test";
    alice = await signIn(app, sent, "alice@dorks.build");
    bob = await signIn(app, sent, "bob@dorks.build");
  });

  it("requires a session", async () => {
    expect((await call(app, "/api/dorks")).status).toBe(401);
    expect((await call(app, "/api/dorks", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("blocks creation until onboarding is complete", async () => {
    const res = await call(app, "/api/dorks", { method: "POST", cookie: alice.cookie, body: JSON.stringify({ repo: "o/r", message: "hi" }) });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "onboarding_incomplete", missing: ["claude_token", "github"] });
  });

  it("validates input", async () => {
    await onboard(alice.userId);
    for (const body of [{ repo: "not a repo", message: "hi" }, { repo: "o/r", message: "  " }, { repo: "o/r" }, "garbage"]) {
      const res = await call(app, "/api/dorks", { method: "POST", cookie: alice.cookie, body: typeof body === "string" ? body : JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });

  let id: string;
  it("creates a dork: D1 row, DO box, creating status", async () => {
    const res = await call(app, "/api/dorks", { method: "POST", cookie: alice.cookie, body: JSON.stringify({ repo: "jaantonio/app", message: "fix the login bug" }) });
    expect(res.status).toBe(201);
    const { dork } = await json(res);
    id = dork.id;
    expect(dork).toMatchObject({ repo_full_name: "jaantonio/app", title: "fix the login bug", status: "creating", archived_at: null });
    expect(dork.branch).toBe(`agent/${id.slice(0, 8)}`);
    const row = await env.DB.prepare("SELECT box_id, user_id FROM dorks WHERE id = ?").bind(id).first<any>();
    expect(row.user_id).toBe(alice.userId);
    expect(row.box_id).toContain("box-");
  });

  it("lists only the caller's dorks, split by archived", async () => {
    const mine = await json(await call(app, "/api/dorks", { cookie: alice.cookie }));
    expect(mine.dorks.map((d: any) => d.id)).toEqual([id]);
    expect((await json(await call(app, "/api/dorks", { cookie: bob.cookie }))).dorks).toEqual([]);
    expect((await json(await call(app, "/api/dorks?archived=1", { cookie: alice.cookie }))).dorks).toEqual([]);
  });

  it("hides other users' dorks on every route (404, not 403)", async () => {
    for (const [method, path, body] of [
      ["GET", `/api/dorks/${id}`], ["PATCH", `/api/dorks/${id}`, { title: "x" }], ["DELETE", `/api/dorks/${id}`],
      ["POST", `/api/dorks/${id}/messages`, { text: "hi" }], ["POST", `/api/dorks/${id}/interrupt`], ["POST", `/api/dorks/${id}/stream-ticket`],
    ] as const) {
      const res = await call(app, path, { method, cookie: bob.cookie, body: body ? JSON.stringify(body) : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // and bob did not damage it
    expect((await call(app, `/api/dorks/${id}`, { cookie: alice.cookie })).status).toBe(200);
  });

  it("accepts messages, mints a ticket, renames", async () => {
    const msg = await call(app, `/api/dorks/${id}/messages`, { method: "POST", cookie: alice.cookie, body: JSON.stringify({ text: "also add tests" }) });
    expect(msg.status).toBe(202);
    expect((await json(msg)).status).toMatchObject({ state: "creating", pendingMessages: 2 });
    expect((await json(await call(app, `/api/dorks/${id}/stream-ticket`, { method: "POST", cookie: alice.cookie }))).ticket).toMatch(/^[0-9a-f]{64}$/);
    const renamed = await json(await call(app, `/api/dorks/${id}`, { method: "PATCH", cookie: alice.cookie, body: JSON.stringify({ title: "Login fix" }) }));
    expect(renamed.dork.title).toBe("Login fix");
  });

  it("archive moves it to the archived tab and refuses new messages (409)", async () => {
    const res = await call(app, `/api/dorks/${id}`, { method: "PATCH", cookie: alice.cookie, body: JSON.stringify({ archived: true }) });
    expect(res.status).toBe(200);
    expect((await json(res)).dork.archived_at).toEqual(expect.any(Number));
    expect((await json(await call(app, "/api/dorks?archived=1", { cookie: alice.cookie }))).dorks).toHaveLength(1);
    expect((await json(await call(app, "/api/dorks", { cookie: alice.cookie }))).dorks).toHaveLength(0);
    const msg = await call(app, `/api/dorks/${id}/messages`, { method: "POST", cookie: alice.cookie, body: JSON.stringify({ text: "wake up" }) });
    expect(msg.status).toBe(409);
    expect(await json(msg)).toMatchObject({ code: "archived" });
    // unarchive restores it to the active list
    await call(app, `/api/dorks/${id}`, { method: "PATCH", cookie: alice.cookie, body: JSON.stringify({ archived: false }) });
    expect((await json(await call(app, "/api/dorks", { cookie: alice.cookie }))).dorks).toHaveLength(1);
  });

  it("delete removes the row and the box", async () => {
    const res = await call(app, `/api/dorks/${id}`, { method: "DELETE", cookie: alice.cookie });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM dorks WHERE id = ?").bind(id).first()).toBeNull();
    expect((await call(app, `/api/dorks/${id}`, { cookie: alice.cookie })).status).toBe(404);
  });
});
