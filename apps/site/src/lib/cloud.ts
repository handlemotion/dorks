import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** The relay, dorks-cloud (Better Auth at /api/auth/*). PUBLIC_CLOUD_URL points the site at another one, such as a local wrangler dev. */
export const CLOUD_URL = (import.meta.env.PUBLIC_CLOUD_URL || "https://api.dorks.build").replace(/\/+$/, "");

/** Better Auth against the relay. Its session cookie lives on the relay's host, so every call sends credentials. */
export const authClient = createAuthClient({
  baseURL: CLOUD_URL,
  fetchOptions: { credentials: "include" },
  plugins: [emailOTPClient(), organizationClient()],
});

export interface SignInMethods {
  google: boolean;
  /** Sign in with Apple on the web (a Services ID and client secret on the relay). `apple` alone is the app's native sign-in. */
  appleWeb?: boolean;
  email: boolean;
}

/** Which methods the relay has configured (`GET /v1/sign-in-methods`). */
export async function fetchSignInMethods(): Promise<SignInMethods> {
  const r = await fetch(`${CLOUD_URL}/v1/sign-in-methods`);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as SignInMethods;
}

/** Where a sign-in may send the visitor afterwards: dorks.build and api.dorks.build only (and this origin and the relay's, for local runs). */
export function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  const allowed = new Set(["https://dorks.build", "https://api.dorks.build", window.location.origin, new URL(CLOUD_URL).origin]);
  return allowed.has(url.origin) ? url.href : null;
}

/**
 * The desktop's sign-in (`/login?next=/onboarding&app=1&state=<nonce>`): signed in, go to onboarding (`next`, or /onboarding),
 * carrying app and state, so it can end by handing the session back to the app through dorks://auth.
 */
export function appNext(params: URLSearchParams): string | null {
  if (params.get("app") !== "1" || !params.get("state")) return null;
  const next = new URL(safeNext(params.get("next")) ?? "/onboarding", window.location.origin);
  if (next.origin !== window.location.origin) next.href = new URL("/onboarding", window.location.origin).href;
  next.searchParams.set("app", "1");
  next.searchParams.set("state", params.get("state")!);
  return next.href;
}

const OTP_ERRORS: Record<string, string> = {
  INVALID_OTP: "That code isn't right.",
  OTP_EXPIRED: "That code has expired. Resend a new one.",
  TOO_MANY_ATTEMPTS: "Too many tries. Resend a new code.",
};

/** Sends a 6-digit sign-in code to `email`. */
export async function sendEmailOtp(email: string) {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
  if (error) throw new Error(error.message || "Could not send code");
}

/** Verifies the code; the relay sets the session cookie. */
export async function verifyEmailOtp(email: string, otp: string) {
  const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: otp.trim() });
  if (error) throw new Error(OTP_ERRORS[error.code ?? ""] ?? (error.message || "Invalid code"));
}

/** Google or Apple: Better Auth redirects to the provider, which comes back to `returnTo` (this page, with its ?next=). */
export async function signInSocial(provider: "google" | "apple", returnTo: string) {
  const error = new URL(returnTo);
  error.searchParams.set("error", provider);
  const r = await authClient.signIn.social({ provider, callbackURL: returnTo, errorCallbackURL: error.href });
  if (r.error) throw new Error(r.error.message || `Could not sign in with ${provider}`);
}
