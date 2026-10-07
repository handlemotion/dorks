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

export const authComponent = createClient<DataModel>(components.betterAuth);

// Every email-otp route that mails a code or checks one. Password-reset routes also mail a code to any existing user, so
// leaving them out would let the send limit be bypassed. (change-email routes are off: `changeEmail.enabled` is not set.)
const SEND_PATHS = ["/email-otp/send-verification-otp", "/email-otp/request-password-reset", "/forget-password/email-otp"];
const VERIFY_PATHS = ["/sign-in/email-otp", "/email-otp/check-verification-otp", "/email-otp/verify-email", "/email-otp/reset-password"];
const allowed = (email: unknown) => isAllowedEmail(email, process.env.ALLOWED_EMAIL_DOMAIN ?? "jaantonio.com");

const limit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Per-hour OTP budgets. Env overrides exist for tests and tuning; the defaults are what production runs. */
const otpLimits = () => ({
  windowMs: limit("OTP_WINDOW_MS", 3_600_000),
  sendPerEmail: limit("OTP_SEND_PER_EMAIL", 5),
  sendPerIp: limit("OTP_SEND_PER_IP", 30),
  verifyPerEmail: limit("OTP_VERIFY_PER_EMAIL", 10),
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

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on the Convex deployment (see docs/auth.md)`);
  return value;
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  // Checked per request, not at import: Convex evaluates modules at deploy time, when env may legitimately be incomplete.
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
        if (!("runMutation" in ctx)) throw new Error("rate limiting needs a mutation-capable context");
        const l = otpLimits();
        const mailbox = rateKeyForEmail(email as string);
        const ip = sending ? clientIp(c.request?.headers ?? c.headers) : undefined;
        const checks =
          sending
            ? [{ key: `otp-send:email:${mailbox}`, limit: l.sendPerEmail }, ...(ip ? [{ key: `otp-send:ip:${ip}`, limit: l.sendPerIp }] : [])]
            : [{ key: `otp-verify:email:${mailbox}`, limit: l.verifyPerEmail }];
        const r = await ctx.runMutation(internal.rateLimit.hit, { checks: checks.map((k) => ({ ...k, windowMs: l.windowMs })) });
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
