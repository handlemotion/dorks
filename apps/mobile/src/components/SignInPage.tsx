import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fonts, useColors } from "@/lib/theme";

/** A sign-in step pushed over the first page (swipe back or the chevron): a heading and a line at the top, the input, and the action pinned above the keyboard. */
export function SignInPage({ title, detail, children, footer }: { title: string; detail?: ReactNode; children: ReactNode; footer: ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.welcome }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
        <View style={styles.body}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={() => router.back()} style={styles.back}>
            <SymbolView name="chevron.left" size={20} tintColor={c.text} weight="medium" />
          </Pressable>
          <View style={styles.head}>
            <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} style={[styles.title, { color: c.text }]}>
              {title}
            </Text>
            {detail ? (
              <Text maxFontSizeMultiplier={1.4} style={[styles.detail, { color: c.muted }]}>
                {detail}
              </Text>
            ) : null}
          </View>
          <View style={styles.content}>{children}</View>
          <View style={styles.footer}>{footer}</View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Six boxes over one hidden field: typing, pasting and the keyboard's one-time-code autofill all fill it. */
export function CodeBoxes({ value, onChange, onSubmit, invalid }: { value: string; onChange: (digits: string) => void; onSubmit: () => void; invalid?: boolean }) {
  const c = useColors();
  const input = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(true);
  return (
    <Pressable onPress={() => input.current?.focus()} style={styles.boxes} accessible={false}>
      {Array.from({ length: 6 }, (_, i) => {
        const current = focused && (i === value.length || (i === 5 && value.length === 6));
        return (
          <View key={i} style={[styles.box, { backgroundColor: c.surface, borderColor: invalid ? c.danger : current ? c.primary : c.border }]}>
            <Text maxFontSizeMultiplier={1.2} style={[styles.digit, { color: c.text }]}>
              {value[i] ?? ""}
            </Text>
          </View>
        );
      })}
      <TextInput
        ref={input}
        accessibilityLabel="6-digit code"
        value={value}
        onChangeText={(next) => onChange(next.replace(/\D/g, "").slice(0, 6))}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        caretHidden
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The keyboard avoider sets its own bottom padding to the keyboard's height, so the gap above the keyboard lives on the view inside it.
  fill: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
  back: { width: 32, height: 44, justifyContent: "center", marginLeft: -4 },
  head: { gap: 8, paddingTop: 12 },
  title: { fontFamily: fonts.semibold, fontSize: 28, lineHeight: 34, letterSpacing: -0.6 },
  detail: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22 },
  content: { flex: 1, paddingTop: 28, gap: 16 },
  footer: { gap: 12 },
  boxes: { flexDirection: "row", gap: 8 },
  box: { flex: 1, height: 60, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  digit: { fontFamily: fonts.medium, fontSize: 24, lineHeight: 30 },
  hidden: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.011, color: "transparent" },
});
