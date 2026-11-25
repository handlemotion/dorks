import { GlassView } from "expo-glass-effect";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useColors } from "@/lib/theme";

/** A round Liquid Glass button with an SF Symbol: the menu button, the sheet's close. */
export function GlassIconButton({ icon, label, onPress, size = 44 }: { icon: SFSymbol; label: string; onPress: () => void; size?: number }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
      <GlassView isInteractive style={[s.center, { width: size, height: size, borderRadius: size / 2 }]}>
        <SymbolView name={icon} size={size * 0.42} tintColor={c.text} />
      </GlassView>
    </Pressable>
  );
}

/** A Liquid Glass capsule around anything: the composer, the PR pills. */
export function GlassCapsule({ children, style, interactive }: { children: ReactNode; style?: StyleProp<ViewStyle>; interactive?: boolean }) {
  return (
    <GlassView isInteractive={interactive} style={style}>
      {children}
    </GlassView>
  );
}

const s = StyleSheet.create({ center: { alignItems: "center", justifyContent: "center" } });
