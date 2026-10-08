import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { createMailer, type Mailer } from "./lib/mailer";

// Built per request: Better Auth instances must not be reused across Workers requests
// (cross-request I/O errors on D1, better-auth#11483).
export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, mailer: Mailer = createMailer(env)) {
  return betterAuth({
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    advanced: { database: { validateSchema: false } } as never,
    trustedOrigins: [env.APP_URL, "dorks://"],
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
