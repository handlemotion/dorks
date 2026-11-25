import { NativeTabs } from "expo-router/native-tabs";
import { useColors } from "@/lib/theme";

/** The native tab bar (Liquid Glass on iOS 26): Chat and Customize. Builds comes later. */
export default function TabsLayout() {
  const c = useColors();
  return (
    <NativeTabs tintColor={c.text} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="index" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left", selected: "bubble.left.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="customize">
        <NativeTabs.Trigger.Label>Customize</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="slider.horizontal.3" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
