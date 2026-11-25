import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassIconButton } from "@/components/Glass";
import { useShell } from "@/components/Shell";
import { type as size, useColors } from "@/lib/theme";

/** A tab page's top bar: the glass menu button in the corner (it slides the app open), the page's title, and an optional action. */
export function Header({ title, right }: { title?: string; right?: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const shell = useShell();
  return (
    <View style={[s.bar, { paddingTop: insets.top + 4 }]}>
      <GlassIconButton icon="line.3.horizontal" label="Open the sidebar" onPress={shell.open} />
      <Text numberOfLines={1} style={[s.title, { color: c.text }]}>
        {title ?? ""}
      </Text>
      <View style={s.right}>{right}</View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  title: { flex: 1, textAlign: "center", fontSize: size.ui, fontWeight: "500" },
  right: { width: 44, alignItems: "flex-end" },
});
