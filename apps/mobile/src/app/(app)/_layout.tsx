import { Stack } from "expo-router";
import { View } from "react-native";
import { Shell } from "@/components/Shell";
import { Sidebar } from "@/components/Sidebar";
import { useSessionToken } from "@/lib/auth";
import { CurrentChatProvider } from "@/lib/chat";
import { MacClientProvider, MacsProvider, useMacs } from "@/lib/macs";
import { useSplashDone } from "@/lib/splash";
import { useColors } from "@/lib/theme";

function AppStack() {
  const c = useColors();
  const { macs, mac, error } = useMacs();
  useSplashDone(macs !== undefined || !!error);
  if (macs === undefined && !error) return <View style={{ flex: 1, backgroundColor: c.background }} />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!mac}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pr" options={{ presentation: "formSheet", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, sheetCornerRadius: 28 }} />
      </Stack.Protected>
      <Stack.Protected guard={!mac}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
      <Stack.Screen name="settings" options={{ headerShown: true, title: "Settings", headerLargeTitle: true, headerTransparent: true }} />
      <Stack.Screen name="pair" options={{ presentation: "formSheet", sheetAllowedDetents: [0.85], sheetGrabberVisible: true, sheetCornerRadius: 28 }} />
    </Stack>
  );
}

/** Signed in: the account's Macs, the picked Mac's client, and the shell (the sidebar under the sliding app). */
export default function AppLayout() {
  const token = useSessionToken() ?? "";
  return (
    <MacsProvider token={token}>
      <MacClientProvider>
        <CurrentChatProvider>
          <Shell sidebar={<Sidebar />}>
            <AppStack />
          </Shell>
        </CurrentChatProvider>
      </MacClientProvider>
    </MacsProvider>
  );
}
