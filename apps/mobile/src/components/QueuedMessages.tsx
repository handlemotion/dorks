import type { QueuedMessage } from "@dorks/client";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type as size, useColors } from "@/lib/theme";

const IMAGE = /!\[[^\]]*\]\(\s*dorks-image:[0-9a-f]{32}\s*\)/g;

/** Messages waiting for the current turn to end, oldest first: each can go now (steering the turn) or be removed. */
export function QueuedMessages({ queue, onSend, onRemove }: { queue: QueuedMessage[]; onSend: (id: string) => void; onRemove: (id: string) => void }) {
  const c = useColors();
  if (!queue.length) return null;
  return (
    <View style={s.list}>
      {queue.map((q) => (
        <View key={q.id} style={s.row}>
          <SymbolView name="clock" size={13} tintColor={c.muted} />
          <Text numberOfLines={1} style={[s.text, { color: c.text }]}>
            {q.text.replace(IMAGE, "").replace(/\s+/g, " ").trim() || "Image"}
          </Text>
          <Pressable onPress={() => onSend(q.id)} hitSlop={8} accessibilityLabel="Send now">
            <SymbolView name="arrow.up" size={15} tintColor={c.muted} />
          </Pressable>
          <Pressable onPress={() => onRemove(q.id)} hitSlop={8} accessibilityLabel="Remove from queue">
            <SymbolView name="xmark" size={14} tintColor={c.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  list: { paddingHorizontal: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, height: 32 },
  text: { flex: 1, fontSize: size.small },
});
