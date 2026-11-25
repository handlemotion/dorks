import * as Haptics from "expo-haptics";
import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { type as size, useColors } from "@/lib/theme";

const HEIGHT = 56;
const PAD = 4;
const KNOB = HEIGHT - PAD * 2;
const SPRING = { damping: 22, stiffness: 240 };

/**
 * A glass track with an arrow knob: drag it to the end to merge. A tick as it crosses the line, success or error haptics after.
 * Let go early and it springs back; a failed merge springs back too.
 */
export function SlideToMerge({ label, disabled, onMerge }: { label: string; disabled?: boolean; onMerge: () => Promise<void> }) {
  const c = useColors();
  const x = useSharedValue(0);
  const max = useSharedValue(0);
  const armed = useSharedValue(false);
  const [busy, setBusy] = useState(false);

  const merge = async () => {
    setBusy(true);
    try {
      await onMerge();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      x.value = withSpring(0, SPRING);
    } finally {
      setBusy(false);
    }
  };
  const tick = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

  const pan = usePanGesture({
    enabled: !disabled && !busy,
    onUpdate: (e) => {
      "worklet";
      x.value = Math.min(max.value, Math.max(0, e.translationX));
      const past = x.value > max.value * 0.9;
      if (past !== armed.value) {
        armed.value = past;
        if (past) scheduleOnRN(tick);
      }
    },
    onDeactivate: () => {
      "worklet";
      if (armed.value) {
        x.value = withSpring(max.value, SPRING);
        scheduleOnRN(merge);
      } else x.value = withSpring(0, SPRING);
      armed.value = false;
    },
  });

  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const text = useAnimatedStyle(() => ({ opacity: max.value ? 1 - x.value / max.value : 1 }));

  return (
    <GlassView style={[s.track, { opacity: disabled ? 0.5 : 1 }]} onLayout={(e) => (max.value = e.nativeEvent.layout.width - KNOB - PAD * 2)}>
      <Animated.Text style={[s.label, { color: c.text }, text]}>{label}</Animated.Text>
      <GestureDetector gesture={pan}>
        <Animated.View style={[s.knob, { backgroundColor: c.brand }, knob]} accessibilityRole="adjustable" accessibilityLabel={label}>
          {busy ? <ActivityIndicator color={c.onBrand} /> : <SymbolView name="arrow.right" size={20} weight="semibold" tintColor={c.onBrand} />}
        </Animated.View>
      </GestureDetector>
    </GlassView>
  );
}

/** "Merge via squash", "base ← head": what the slide will do, above it. */
export function MergeFacts({ method, base, head }: { method: string; base: string; head: string }) {
  const c = useColors();
  return (
    <View style={s.facts}>
      <Text style={[s.fact, { color: c.text }]}>Merge via {method}</Text>
      <Text numberOfLines={1} style={[s.fact, { color: c.muted, fontFamily: size.mono }]}>
        {base} ← {head}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  track: { height: HEIGHT, borderRadius: HEIGHT / 2, justifyContent: "center", padding: PAD },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2, alignItems: "center", justifyContent: "center" },
  label: { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: size.ui },
  facts: { gap: 4 },
  fact: { fontSize: size.small },
});
