import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const sent: Record<string, string> = {};
const app = createApp({ mailer: () => ({ async sendOtp(to, code) { sent[to] = code; } }) });

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://localhost:3000${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) });

describe("auth", () => {
  it("rejects unauthenticated API calls", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/health")).status).toBe(200);
  });

  it("completes the code flow for an allowed email and yields a session", async () => {
    const email = "rodrigo@dorks.build";
    expect((await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    expect(sent[email]).toMatch(/^\d{6}$/);

    const signIn = await post("/api/auth/sign-in/email-otp", { email, otp: sent[email] });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");

    const me = await call("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);
  });

  it("rejects a wrong code", async () => {
    const email = "wrong@dorks.build";
    await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect((await post("/api/auth/sign-in/email-otp", { email, otp: "000000" })).status).toBe(400);
  });
});
