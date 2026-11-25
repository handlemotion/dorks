import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Header } from "@/components/Header";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

/** Before any Mac is paired (or when the list cannot be read): what to do, and the one button that does it. */
export default function Welcome() {
  const c = useColors();
  const router = useRouter();
  const { error, refresh } = useMacs();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <Header />
      <View style={s.center}>
        <SymbolView name="laptopcomputer" size={44} tintColor={c.muted} />
        <Text style={[s.title, { color: c.text }]}>{error ? "Cannot reach Dorks Cloud" : "Pair your Mac"}</Text>
        <Text style={[s.detail, { color: c.muted }]}>{error ?? "Dorks runs on your Mac. On it, open Settings, Phone, and choose Pair a phone; then scan the code here."}</Text>
        <Pressable onPress={() => (error ? void refresh() : router.push("/pair"))} style={[s.button, { borderColor: c.hairline }]}>
          <Text style={[s.buttonText, { color: c.text }]}>{error ? "Try again" : "Scan the code"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  title: { fontSize: 20, fontWeight: "500", marginTop: 8 },
  detail: { fontSize: size.ui, lineHeight: 21, textAlign: "center" },
  button: { marginTop: 10, height: 36, paddingHorizontal: 14, borderRadius: radius.control, borderWidth: 1, justifyContent: "center" },
  buttonText: { fontSize: size.small, fontWeight: "500" },
});
