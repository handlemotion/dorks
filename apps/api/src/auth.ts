import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { isAllowedEmail } from "./lib/domain";
import { createMailer, type Mailer } from "./lib/mailer";

const OTP_PATHS = ["/email-otp/send-verification-otp", "/sign-in/email-otp"];

// Built per request: Better Auth instances must not be reused across Workers requests
// (cross-request I/O errors on D1, better-auth#11483).
export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, mailer: Mailer = createMailer(env)) {
  const allowed = (email: unknown) => isAllowedEmail(email, env.ALLOWED_EMAIL_DOMAIN);
  return betterAuth({
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    advanced: { database: { validateSchema: false } } as never,
    trustedOrigins: [env.APP_URL, "dorks://"],
    hooks: {
      before: createAuthMiddleware(async (c) => {
        if (OTP_PATHS.includes(c.path) && !allowed((c.body as { email?: unknown } | undefined)?.email)) {
          throw new APIError("FORBIDDEN", { message: "Email domain not allowed" });
        }
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
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp }) {
          ctx.waitUntil(mailer.sendOtp(email, otp));
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
