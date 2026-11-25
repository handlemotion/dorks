import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { fonts, useColors } from "@/lib/theme";

const GLYPH = { sm: 15, field: 18 };

export interface ButtonProps extends Omit<PressableProps, "children"> {
  label: string;
  /** `primary` filled brand, `outline` bordered on the canvas, `quiet` text only (a secondary action in place). */
  intent?: "primary" | "outline" | "quiet";
  size?: "sm" | "md" | "lg";
  /** A glyph before the label, drawn at `size` in `color`. */
  icon?: (glyph: { size: number; color: string }) => ReactNode;
  /** The action is running: dimmed like a disabled button, a spinner in place of the glyph. */
  isPending?: boolean;
}

/** A labelled action (Wok's iOS button): the label centred, a glyph or the pending spinner at the leading edge. Squeezes to 0.97 while pressed. */
export function Button({ label, intent = "primary", size = "md", isPending, disabled, icon, style, ...props }: ButtonProps) {
  const c = useColors();
  const primary = intent === "primary";
  const ink = primary ? "#ffffff" : c.text;
  const glyph = size === "sm" ? GLYPH.sm : GLYPH.field;
  const fill =
    intent === "primary"
      ? { backgroundColor: c.primaryButton, borderWidth: 1, borderColor: c.primary }
      : intent === "outline"
        ? { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }
        : styles.quiet;
  const quiet = intent === "quiet";
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || isPending), busy: !!isPending }}
      disabled={disabled || isPending}
      style={(state) => [styles.base, styles[size], fill, (disabled || isPending) && styles.dimmed, state.pressed && styles.pressed, typeof style === "function" ? style(state) : style]}
    >
      {!quiet && (isPending || icon) ? <View style={[styles.lead, { width: glyph }]}>{isPending ? <Spinner size={glyph} color={ink} /> : icon?.({ size: glyph, color: ink })}</View> : null}
      <View style={[styles.row, quiet && styles.flush]}>
        {quiet && isPending ? <Spinner size={glyph} color={ink} /> : null}
        <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={[size === "sm" ? styles.smLabel : styles.label, { color: ink }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/** A ring that turns, for a pending button; still when Reduce Motion is on. */
export function Spinner({ size = 18, color }: { size?: number; color: string }) {
  const still = useReducedMotion();
  const angle = useSharedValue(0);
  useEffect(() => {
    angle.value = 0;
    if (!still) angle.value = withRepeat(withTiming(360, { duration: 750, easing: Easing.linear }), -1, false);
  }, [still, angle]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  const ring = size * 0.8;
  return (
    <Animated.View style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, spin]}>
      <View style={{ width: ring, height: ring, borderRadius: ring / 2, borderWidth: 1.25, borderColor: color, borderTopColor: "transparent" }} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: 999, alignItems: "center", justifyContent: "center" },
  sm: { minHeight: 34, paddingHorizontal: 14 },
  md: { minHeight: 44, paddingHorizontal: 18 },
  lg: { minHeight: 48, paddingHorizontal: 20 },
  quiet: { minHeight: 36, paddingHorizontal: 0, alignSelf: "flex-start" },
  /** A text-only button keeps its spinner inline, before the label. */
  flush: { paddingHorizontal: 0, gap: 6 },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
  /** The glyph sits at the button's leading edge, so labels in a stack of buttons share one centre line. */
  lead: { position: "absolute", left: 20, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", maxWidth: "100%", paddingHorizontal: 28 },
  label: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontFamily: fonts.medium },
  smLabel: { flexShrink: 1, fontSize: 13, lineHeight: 18, fontFamily: fonts.medium },
});
