import { Button, Host, Menu } from "@expo/ui/swift-ui";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Updates from "expo-updates";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { authClient } from "@/lib/auth";
import { cloud, type Mac } from "@/lib/cloud";
import { ago, errorText } from "@/lib/format";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

function MacRow({ mac, current, onError }: { mac: Mac; current: boolean; onError: (e?: string) => void }) {
  const c = useColors();
  const { token, select, refresh } = useMacs();
  const unpair = () =>
    Alert.alert(`Unpair ${mac.name}?`, "This phone stops reaching it until you pair it again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: () => void cloud.unpair(token, mac.id).then(refresh, (e) => onError(errorText(e))),
      },
    ]);
  return (
    <Pressable onPress={() => select(mac.id)} style={[s.row, { borderBottomColor: c.hairline }]}>
      <View style={[s.dot, { backgroundColor: mac.online ? c.open : c.draft }]} />
      <View style={s.rowText}>
        <Text style={[s.title, { color: c.text }]}>{mac.name}</Text>
        <Text style={[s.detail, { color: c.muted }]}>{mac.online ? "Online" : `Offline${ago(mac.lastSeenAt) ? `, seen ${ago(mac.lastSeenAt)}` : ""}`}</Text>
      </View>
      {current && <SymbolView name="checkmark" size={16} tintColor={c.brand} />}
      <Host matchContents>
        <Menu label="" systemImage="ellipsis">
          <Button label="Use this Mac" systemImage="checkmark" onPress={() => select(mac.id)} />
          <Button label="Unpair" systemImage="xmark" role="destructive" onPress={unpair} />
        </Menu>
      </Host>
    </Pressable>
  );
}

/** Settings: the paired Macs (online or not; pick, unpair), pairing another, signing out. */
export default function SettingsScreen() {
  const c = useColors();
  const router = useRouter();
  const { macs, mac, error: loadError } = useMacs();
  const [error, setError] = useState<string>();
  const { data } = authClient.useSession();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.background }} contentContainerStyle={s.body}>
      <View style={s.section}>
        <Text style={[s.sectionTitle, { color: c.muted }]}>Macs</Text>
        <View style={[s.rows, { borderTopColor: c.hairline }]}>
          {macs?.map((m) => (
            <MacRow key={m.id} mac={m} current={m.id === mac?.id} onError={setError} />
          ))}
          {macs?.length === 0 && <Text style={[s.detail, { color: c.muted, paddingVertical: 12 }]}>No Mac paired yet</Text>}
        </View>
        {(error ?? loadError) && <Text style={[s.detail, { color: c.danger }]}>{error ?? loadError}</Text>}
        <Pressable onPress={() => router.push("/pair")} style={[s.button, { backgroundColor: c.fill }]}>
          <SymbolView name="qrcode.viewfinder" size={17} tintColor={c.text} />
          <Text style={[s.title, { color: c.text }]}>Pair a Mac</Text>
        </Pressable>
        <Text style={[s.detail, { color: c.muted }]}>On your Mac, open Dorks, Settings, Phone, and choose Pair a phone.</Text>
      </View>

      <View style={s.section}>
        <Text style={[s.sectionTitle, { color: c.muted }]}>Account</Text>
        {data?.user.email ? <Text style={[s.detail, { color: c.muted }]}>{data.user.email}</Text> : null}
        <Pressable onPress={() => void authClient.signOut()} style={[s.button, { backgroundColor: c.fill }]}>
          <Text style={[s.title, { color: c.danger }]}>Sign out</Text>
        </Pressable>
      </View>

      <Text style={[s.detail, { color: c.muted }]}>
        Dorks {Application.nativeApplicationVersion} ({Application.nativeBuildVersion}){Updates.channel ? ` · ${Updates.channel}` : ""}
        {Updates.updateId ? ` · update ${Updates.updateId.slice(0, 8)}` : ""}
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 20, gap: 32 },
  section: { gap: 10 },
  sectionTitle: { fontSize: size.small },
  rows: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { fontSize: size.ui },
  detail: { fontSize: size.small, lineHeight: 18 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 44, borderRadius: radius.control },
});
