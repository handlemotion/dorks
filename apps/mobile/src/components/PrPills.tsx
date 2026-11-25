import { useSubscriptions } from "@dorks/client/react";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GlassCapsule } from "@/components/Glass";
import { prColor, type as size, useColors } from "@/lib/theme";

/** The session's open pull requests as glass pills above the composer (`#201` and its state); a tap opens the PR sheet. */
export function PrPills({ dorkId }: { dorkId: string }) {
  const c = useColors();
  const router = useRouter();
  const open = (useSubscriptions(dorkId) ?? []).filter((p) => p.state === "open");
  if (!open.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
      {open.map((p) => (
        <Pressable key={p.url} onPress={() => router.push({ pathname: "/pr", params: { dork: dorkId, url: p.url } })} accessibilityLabel={`Pull request #${p.number}`}>
          <GlassCapsule interactive style={s.pill}>
            <View style={[s.dot, { backgroundColor: prColor(c, p.state) }]} />
            <Text style={[s.number, { color: c.text }]}>#{p.number}</Text>
            {p.title && (
              <Text numberOfLines={1} style={[s.title, { color: c.muted }]}>
                {p.title}
              </Text>
            )}
          </GlassCapsule>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 2 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, maxWidth: 260 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  number: { fontSize: size.small, fontVariant: ["tabular-nums"] },
  title: { fontSize: size.small, flexShrink: 1 },
});
