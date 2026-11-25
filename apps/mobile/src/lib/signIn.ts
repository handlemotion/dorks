import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { CLOUD_URL } from "./config";

/**
 * Google OAuth through Better Auth's Expo client: opens Google's consent screen in an `ASWebAuthenticationSession`, returns to
 * `dorks://`, stores the session cookie in SecureStore and updates `authClient.useSession`.
 */
export async function signInWithGoogle() {
  const { error } = await authClient.signIn.social({
    provider: "google",
    callbackURL: Linking.createURL("/"),
    errorCallbackURL: Linking.createURL("/sign-in", { queryParams: { error: "google" } }),
  });
  if (error) throw new Error(error.message || "Could not sign in with google");
}

/** Sign in with Apple, natively: Apple's ID token goes to Better Auth on the relay, which makes the session. Cancelling is not an error. */
export async function signInWithApple() {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL, AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
    });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED") return;
    throw e;
  }
  if (!credential.identityToken) throw new Error("Could not sign in with apple");
  const { error } = await authClient.signIn.social({ provider: "apple", idToken: { token: credential.identityToken } });
  if (error) throw new Error(error.message || "Could not sign in with apple");
}

/** Sends a 6-digit sign-in code to `email`. */
export async function sendEmailOtp(email: string) {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
  if (error) throw new Error(error.message || "Could not send code");
}

/** Verifies the 6-digit code and saves the session cookie into SecureStore. */
export async function verifyEmailOtp(email: string, otp: string) {
  const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: otp.trim() });
  if (error) throw new Error(error.message || "Invalid code");
}

export interface SignInMethods {
  google: boolean;
  apple: boolean;
  email: boolean;
}

let methodsCache: Promise<SignInMethods> | undefined;

/** Which sign-in methods the relay has configured (`GET /v1/sign-in-methods`), asked once per launch; undefined until it answers. */
export function useSignInMethods(): SignInMethods | undefined {
  const [methods, setMethods] = useState<SignInMethods>();
  useEffect(() => {
    let live = true;
    methodsCache ??= fetch(`${CLOUD_URL}/v1/sign-in-methods`).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<SignInMethods>;
    });
    methodsCache.then(
      (m) => live && setMethods(m),
      () => {
        methodsCache = undefined;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return methods;
}

/** One async action's state, as a mutation: `run` it, read `isPending`, `isSuccess` and `error`. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>, opts?: { onSuccess?: () => void; onError?: () => void }) {
  const [state, setState] = useState<{ isPending: boolean; isSuccess: boolean; error: Error | null }>({ isPending: false, isSuccess: false, error: null });
  const latest = useRef({ fn, opts });
  latest.current = { fn, opts };
  const run = useCallback((...args: A) => {
    setState({ isPending: true, isSuccess: false, error: null });
    latest.current.fn(...args).then(
      () => {
        setState({ isPending: false, isSuccess: true, error: null });
        latest.current.opts?.onSuccess?.();
      },
      (e: unknown) => {
        setState({ isPending: false, isSuccess: false, error: e instanceof Error ? e : new Error(String(e)) });
        latest.current.opts?.onError?.();
      },
    );
  }, []);
  return { ...state, run };
}
