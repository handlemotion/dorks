import type { Block, DorkState } from "@dorks/shared";
import type { LiveStatus } from "@dorks/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { workedFor } from "@/lib/format";
import { type as size, useColors } from "@/lib/theme";
import { currentStep } from "@/lib/tools";

/** The step it works on since when, or why it stopped; above everything, whether the Mac can be reached at all. */
export function StatusLine({ state, live, blocks }: { state: DorkState; live: LiveStatus; blocks: Block[] }) {
  const c = useColors();
  const since = workingSince(state, blocks);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state !== "working") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  const last = blocks.at(-1);
  const text =
    live === "offline"
      ? "Your Mac is offline. Dorks needs it awake to answer."
      : live === "unauthorized"
        ? "Signed out of Dorks Cloud. Sign in again in Settings."
        : state === "working"
          ? `${currentStep(blocks) ?? "Working"}${since ? ` · ${workedFor(now - since)}` : ""}`
          : state === "creating"
            ? "Starting the sandbox"
            : state === "waking"
              ? "Waking up"
              : state === "error"
                ? last?.kind === "notice" && last.level === "error"
                  ? last.text
                  : "Something went wrong"
                : undefined;
  if (!text) return null;
  const moving = live === "live" && (state === "working" || state === "creating" || state === "waking");
  return (
    <View style={s.row}>
      {moving && <ActivityIndicator size="small" color={c.muted} />}
      <Text numberOfLines={2} style={[s.text, { color: state === "error" ? c.danger : c.muted }]}>
        {text}
      </Text>
    </View>
  );
}

/** When the running turn started: its user message, else the first block after the last finished turn. */
function workingSince(state: DorkState, blocks: Block[]): number | undefined {
  if (state !== "working") return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "turn") return undefined;
    if (b.kind === "user") return b.at;
  }
  return undefined;
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 },
  text: { fontSize: size.ui, flexShrink: 1 },
});
