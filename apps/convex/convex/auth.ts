import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { isAllowedEmail } from "../../api/src/lib/domain";
import { sendOtpMail } from "./mail";
import { MAX_WINDOW_MS } from "./rateLimit";

export const authComponent = createClient<DataModel>(components.betterAuth);

// email-otp routes that mail a code (rate limited) or check one (domain check only). Password-reset routes also mail a code to
// any existing user, so leaving them out would let the send limit be bypassed. change-email routes are off (`changeEmail.enabled` unset).
// Checks are not rate limited: better-auth already voids a code after 3 wrong guesses, and a per-mailbox cap would only let
// anyone lock a known colleague out.
const SEND_PATHS = ["/email-otp/send-verification-otp", "/email-otp/request-password-reset", "/forget-password/email-otp"];
const VERIFY_PATHS = ["/sign-in/email-otp", "/email-otp/check-verification-otp", "/email-otp/verify-email", "/email-otp/reset-password"];
const allowed = (email: unknown) => isAllowedEmail(email, process.env.ALLOWED_EMAIL_DOMAIN ?? "jaantonio.com");

const limit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Per-window send budgets. Env overrides exist for tests and tuning; the defaults are what production runs. */
export const otpLimits = () => ({
  windowMs: Math.min(limit("OTP_WINDOW_MS", 3_600_000), MAX_WINDOW_MS), // the sweep deletes counters older than MAX_WINDOW_MS
  sendPerEmail: limit("OTP_SEND_PER_EMAIL", 5),
  sendPerIp: limit("OTP_SEND_PER_IP", 30),
  sendGlobal: limit("OTP_SEND_GLOBAL", 100), // the only budget a caller cannot influence (no header or address trick dodges it)
});

/** One mailbox, one key: `Rodrigo+x@` and `rodrigo+y@` land in the same inbox, so they must share a budget. */
export const rateKeyForEmail = (email: string) => {
  const [local, domain] = email.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
};

/**
 * Client IP as seen by the HTTP action. Takes the last `x-forwarded-for` hop: that is the one our own edge appended, while
 * earlier hops can be forged by the caller. Undefined when no proxy header is present (the per-email limits still apply).
 */
export const clientIp = (headers: Headers | undefined) => headers?.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined;

/** Budgets one code send must fit in. The global key is always present; the IP key only when a proxy header names one. */
export const sendChecks = (email: string, ip: string | undefined, l = otpLimits()) => [
  { key: `otp-send:email:${rateKeyForEmail(email)}`, limit: l.sendPerEmail },
  ...(ip ? [{ key: `otp-send:ip:${ip}`, limit: l.sendPerIp }] : []),
  { key: "otp-send:global", limit: l.sendGlobal },
];

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on the Convex deployment (see docs/auth.md)`);
  return value;
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  // `registerRoutes` (http.ts) builds the auth at module load, so a missing variable fails the deploy ("Failed to analyze http.js"),
  // not the first request. The same check runs per request as a backstop.
  const siteUrl = requireEnv("SITE_URL"); // otherwise it is silently dropped from trustedOrigins and web sign-in just fails
  const secret = requireEnv("BETTER_AUTH_SECRET");
  return betterAuth({
    baseURL: process.env.CONVEX_SITE_URL,
    secret,
    database: authComponent.adapter(ctx),
    trustedOrigins: [siteUrl, "dorks://", ...(process.env.EXTRA_TRUSTED_ORIGINS?.split(",").map((o: string) => o.trim()).filter(Boolean) ?? [])],
    hooks: {
      before: createAuthMiddleware(async (c) => {
        const sending = SEND_PATHS.includes(c.path);
        if (!sending && !VERIFY_PATHS.includes(c.path)) return;
        const email = (c.body as { email?: unknown } | undefined)?.email;
        if (!allowed(email)) throw new APIError("FORBIDDEN", { message: "Email domain not allowed" });
        if (!sending) return;
        if (!("runMutation" in ctx)) throw new Error("rate limiting needs a mutation-capable context");
        const l = otpLimits();
        const checks = sendChecks(email as string, clientIp(c.request?.headers ?? c.headers), l).map((k) => ({ ...k, windowMs: l.windowMs }));
        const r = await ctx.runMutation(internal.rateLimit.hit, { checks });
        if (!r.ok) throw new APIError("TOO_MANY_REQUESTS", { message: `Too many attempts. Try again in ${Math.ceil(r.retryAfterMs / 60_000)} min.` });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!allowed(user.email)) throw new APIError("FORBIDDEN", { message: "Email domain not allowed" });
            return { data: user };
          },
        },
      },
    },
    plugins: [
      expo(), // native app: Expo SecureStore session + dorks:// deep link
      crossDomain({ siteUrl }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp }) {
          await sendOtpMail(email, otp);
        },
      }),
      convex({ authConfig }),
    ],
  });
};

/** Auth user id for the current request, or throws. Every public function starts here. */
export async function requireUserId(ctx: GenericCtx<DataModel>): Promise<string> {
  return (await authComponent.getAuthUser(ctx))._id;
}
