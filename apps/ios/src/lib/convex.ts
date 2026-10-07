import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { expoClient } from '@better-auth/expo/client';
import { emailOTPClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, { unsavedChangesWarning: false });

// Native: session cookie lives in SecureStore (expoClient reads Set-Cookie, which native fetch exposes).
// Web (`expo start --web`): browsers hide Set-Cookie from fetch, so use the same crossDomain flow as apps/web.
export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_CONVEX_SITE_URL!,
  plugins: [
    emailOTPClient(),
    convexClient(),
    Platform.OS === 'web' ? crossDomainClient() : expoClient({ scheme: 'dorks', storagePrefix: 'dorks', storage: SecureStore }),
  ],
});
