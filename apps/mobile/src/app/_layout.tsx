import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { authClient } from "@/lib/auth";
import { useColors, useIsDark } from "@/lib/theme";

/** An EAS Update downloaded at launch (expo-updates checks on load) is applied at once, before there is anything to lose. */
function useLaunchUpdate() {
  const { isUpdatePending } = Updates.useUpdates();
  useEffect(() => {
    if (isUpdatePending && !__DEV__) void Updates.reloadAsync();
  }, [isUpdatePending]);
}

export default function RootLayout() {
  const c = useColors();
  const dark = useIsDark();
  const { data: session, isPending } = authClient.useSession();
  useLaunchUpdate();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: c.background, card: c.background, text: c.text, border: c.hairline, primary: c.brand } };
  if (isPending) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={theme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={!!session}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={!session}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
