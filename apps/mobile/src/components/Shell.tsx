import { useSegments } from "expo-router";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useColors } from "@/lib/theme";

// The app slides right to show the sidebar under it: the glass menu button opens it, and so does a pan from the left edge. A tap on
// the app, or a pan back, closes it. Nothing casts a shadow; the sidebar is the app's off-white plane under the page.

const SPRING = { damping: 28, stiffness: 260, mass: 0.9 };
const EDGE = 24;

const Ctx = createContext<{ open: () => void; close: () => void }>({ open: () => {}, close: () => {} });
export const useShell = () => useContext(Ctx);

export function Shell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const travel = Math.min(width * 0.84, 360);
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const [isOpen, setOpen] = useState(false);
  // The edge pan only on the tab pages: a pushed page (Settings) keeps the system's own swipe back.
  const segments = useSegments() as string[];
  const onTabs = segments.includes("(tabs)") || segments.includes("welcome");

  const settle = useCallback(
    (open: boolean) => {
      setOpen(open);
      x.value = withSpring(open ? travel : 0, SPRING);
    },
    [travel, x],
  );
  const value = useMemo(() => ({ open: () => settle(true), close: () => settle(false) }), [settle]);

  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-14, 14],
    onActivate: () => {
      "worklet";
      start.value = x.value;
    },
    onUpdate: (e) => {
      "worklet";
      x.value = Math.min(travel, Math.max(0, start.value + e.translationX));
    },
    onDeactivate: (e) => {
      "worklet";
      const open = e.velocityX > 500 || (e.velocityX > -500 && x.value > travel / 2);
      scheduleOnRN(settle, open);
    },
  });

  const page = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const under = useAnimatedStyle(() => ({ opacity: 0.4 + (0.6 * x.value) / travel }));

  return (
    <Ctx.Provider value={value}>
      <View style={[s.fill, { backgroundColor: c.app }]}>
        <Animated.View style={[s.sidebar, { width: travel }, under]} pointerEvents={isOpen ? "auto" : "none"}>
          {sidebar}
        </Animated.View>
        <Animated.View style={[s.fill, { backgroundColor: c.background }, page]}>
          {children}
          {isOpen ? (
            <GestureDetector gesture={pan}>
              <Pressable style={StyleSheet.absoluteFill} onPress={value.close} accessibilityLabel="Close the sidebar" />
            </GestureDetector>
          ) : (
            onTabs && (
              <GestureDetector gesture={pan}>
                <View style={s.edge} />
              </GestureDetector>
            )
          )}
        </Animated.View>
      </View>
    </Ctx.Provider>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  sidebar: { position: "absolute", top: 0, bottom: 0, left: 0 },
  // Below the header, so the menu button in the corner stays tappable.
  edge: { position: "absolute", top: 120, bottom: 0, left: 0, width: EDGE },
});
