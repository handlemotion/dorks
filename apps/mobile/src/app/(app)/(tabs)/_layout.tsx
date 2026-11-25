import { Tabs, TabList, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/lib/theme";

/** The tabs (headless, so the bar is ours): a compact row of icons on the page, the selected one on a soft pill. */
export default function TabsLayout() {
  return (
    <Tabs>
      <TabSlot />
      <TabList asChild>
        <Bar>
          <TabTrigger name="index" href="/" asChild>
            <TabButton icon="house" selected="house.fill" label="Chat" />
          </TabTrigger>
          <TabTrigger name="customize" href="/customize" asChild>
            <TabButton icon="square.grid.2x2" selected="square.grid.2x2.fill" label="Customize" />
          </TabTrigger>
        </Bar>
      </TabList>
    </Tabs>
  );
}

function Bar({ style, ...props }: ComponentProps<typeof View>) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return <View {...props} style={[style, s.bar, { backgroundColor: c.background, paddingBottom: Math.max(insets.bottom - 6, 6) }]} />;
}

function TabButton({ icon, selected, label, isFocused, ...props }: TabTriggerSlotProps & { icon: SFSymbol; selected: SFSymbol; label: string }) {
  const c = useColors();
  return (
    <Pressable
      {...(props as ComponentProps<typeof Pressable>)}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isFocused }}
      style={[s.tab, isFocused && { backgroundColor: c.selected }]}
    >
      <SymbolView name={isFocused ? selected : icon} size={23} tintColor={isFocused ? c.text : c.muted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", justifyContent: "space-evenly", paddingTop: 6 },
  tab: { width: 64, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
