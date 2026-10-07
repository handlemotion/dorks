import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { isAllowedEmail } from "../../api/src/lib/domain";
import { sendOtpMail } from "./mail";

export const authComponent = createClient<DataModel>(components.betterAuth);

const OTP_PATHS = ["/email-otp/send-verification-otp", "/sign-in/email-otp"];
const allowed = (email: unknown) => isAllowedEmail(email, process.env.ALLOWED_EMAIL_DOMAIN ?? "jaantonio.com");

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.CONVEX_SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: authComponent.adapter(ctx),
    trustedOrigins: [process.env.SITE_URL!, "dorks://", ...(process.env.EXTRA_TRUSTED_ORIGINS?.split(",") ?? [])],
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
      expo(), // native app: Expo SecureStore session + dorks:// deep link
      crossDomain({ siteUrl: process.env.SITE_URL! }),
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

/** Auth user id for the current request, or throws. Every public function starts here. */
export async function requireUserId(ctx: GenericCtx<DataModel>): Promise<string> {
  return (await authComponent.getAuthUser(ctx))._id;
}
