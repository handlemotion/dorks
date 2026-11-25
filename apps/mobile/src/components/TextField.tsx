import { useState } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";
import { useColors } from "@/lib/theme";

export interface TextFieldProps extends TextInputProps {
  /** Read by VoiceOver; the field shows no visible label. */
  label: string;
}

/** A text field (Wok's iOS field): a pill on the surface. Focus shows as a primary-coloured border only. */
export function TextField({ label, style, onFocus, onBlur, ...props }: TextFieldProps) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...props}
      accessibilityLabel={label}
      maxFontSizeMultiplier={1.4}
      placeholderTextColor={c.subtle}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[styles.input, { color: c.text, backgroundColor: c.surface, borderColor: focused ? c.primary : c.border }, style]}
    />
  );
}

const styles = StyleSheet.create({
  input: { fontSize: 15, lineHeight: 20, height: 48, paddingHorizontal: 20, borderRadius: 999, borderWidth: 1 },
});
