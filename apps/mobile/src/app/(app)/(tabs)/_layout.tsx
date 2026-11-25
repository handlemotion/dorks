import { Image } from "expo-image";
import { Tabs, TabList, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/lib/theme";

const ICONS = {
  chat: [require("../../../../assets/tabs/tab-chat.png"), require("../../../../assets/tabs/tab-chatFill.png")],
  customize: [require("../../../../assets/tabs/tab-custom.png"), require("../../../../assets/tabs/tab-customFill.png")],
} satisfies Record<string, [number, number]>;

/** The tabs (headless, so the bar is ours): two icons close together at the centre, the selected one filled on a soft pill. */
export default function TabsLayout() {
  return (
    <Tabs>
      <TabSlot />
      <TabList asChild>
        <Bar>
          <TabTrigger name="index" href="/" asChild>
            <TabButton icons={ICONS.chat} label="Chat" />
          </TabTrigger>
          <TabTrigger name="customize" href="/customize" asChild>
            <TabButton icons={ICONS.customize} label="Customize" />
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

function TabButton({ icons, label, isFocused, ...props }: TabTriggerSlotProps & { icons: [number, number]; label: string }) {
  const c = useColors();
  return (
    <Pressable
      {...(props as ComponentProps<typeof Pressable>)}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isFocused }}
      style={[s.tab, isFocused && { backgroundColor: c.selected }]}
    >
      <Image source={isFocused ? icons[1] : icons[0]} tintColor={isFocused ? c.text : c.muted} style={s.icon} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", justifyContent: "center", gap: 28, paddingTop: 6 },
  tab: { width: 64, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  icon: { width: 24, height: 24 },
});
