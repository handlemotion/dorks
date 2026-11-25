import { NativeTabs } from "expo-router/native-tabs";
import { useColors } from "@/lib/theme";

/** The native tab bar (Liquid Glass), icons only: Chat and Customize. Builds comes later. */
export default function TabsLayout() {
  const c = useColors();
  return (
    <NativeTabs tintColor={c.text} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="index" disableAutomaticContentInsets accessibilityLabel="Chat">
        <NativeTabs.Trigger.Label hidden />
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="customize" accessibilityLabel="Customize">
        <NativeTabs.Trigger.Label hidden />
        <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
