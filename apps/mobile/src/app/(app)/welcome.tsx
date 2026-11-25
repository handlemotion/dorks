import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Header } from "@/components/Header";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

/** Before any Mac is paired, or when the cloud cannot be reached: one title and the one button. */
export default function Welcome() {
  const c = useColors();
  const router = useRouter();
  const { error, refresh } = useMacs();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <Header />
      <View style={s.center}>
        <SymbolView name="laptopcomputer" size={44} tintColor={c.muted} />
        <Text style={[s.title, { color: c.text }]}>{error ? "Can't reach Dorks Cloud" : "Pair your Mac"}</Text>
        <Pressable onPress={() => (error ? void refresh() : router.push("/pair"))} style={[s.button, { borderColor: c.hairline }]}>
          <Text style={[s.buttonText, { color: c.text }]}>{error ? "Try again" : "Scan code"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  title: { fontSize: 20, fontWeight: "500", marginTop: 8 },
  button: { marginTop: 10, height: 36, paddingHorizontal: 14, borderRadius: radius.control, borderWidth: 1, justifyContent: "center" },
  buttonText: { fontSize: size.small, fontWeight: "500" },
});
