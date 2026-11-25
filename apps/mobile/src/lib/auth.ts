import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { CLOUD_URL } from "./config";

/** Better Auth against the relay; the session (and its cookie) is kept in the keychain. */
export const authClient = createAuthClient({
  baseURL: CLOUD_URL,
  plugins: [expoClient({ scheme: "dorks", storagePrefix: "dorks", storage: SecureStore })],
});

/** The signed-in session's token: the relay reads it as a bearer token, for its own routes and the relayed UI API alike. */
export function useSessionToken(): string | undefined {
  return authClient.useSession().data?.session.token;
}
