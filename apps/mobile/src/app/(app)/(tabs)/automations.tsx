import type { AutomationView } from "@dorks/shared";
import { useAutomations, useDorksClient } from "@dorks/client/react";
import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Header } from "@/components/Header";
import { useCurrentChat } from "@/lib/chat";
import { ago, errorText } from "@/lib/format";
import { useRouter } from "expo-router";
import { type as size, useColors } from "@/lib/theme";

/** Automations (docs/automations.md): each one on or off, its last run, run it now, open the session a run started. */
export default function AutomationsTab() {
  const c = useColors();
  const automations = useAutomations();
  const [error, setError] = useState<string>();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <Header />
      <ScrollView contentContainerStyle={s.body}>
        {automations === undefined ? <ActivityIndicator color={c.muted} /> : automations.map((a) => <AutomationRow key={a.id} automation={a} onError={setError} />)}
        {error && <Text style={[s.detail, { color: c.danger }]}>{error}</Text>}
      </ScrollView>
    </View>
  );
}

function lastRunText(a: AutomationView): string | undefined {
  const r = a.lastRun;
  if (!r) return undefined;
  const when = ago(r.createdAt);
  return [r.status === "started" ? r.summary : (r.error ?? r.status), when].filter(Boolean).join(" · ");
}

function AutomationRow({ automation: a, onError }: { automation: AutomationView; onError: (e?: string) => void }) {
  const c = useColors();
  const { actions } = useDorksClient();
  const { setDorkId } = useCurrentChat();
  const router = useRouter();
  const act = (p: Promise<unknown>) =>
    p.then(
      () => onError(undefined),
      (e) => onError(errorText(e)),
    );
  const session = a.lastRun?.dork && !a.lastRun.dork.archived ? a.lastRun.dork : null;
  const detail = lastRunText(a);
  return (
    <View style={[s.row, { borderBottomColor: c.hairline }]}>
      <View style={s.text}>
        <Text numberOfLines={1} style={[s.title, { color: c.text }]}>
          {a.name}
        </Text>
        {detail ? (
          <Text numberOfLines={1} style={[s.detail, { color: a.lastRun?.status === "failed" ? c.danger : c.muted }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Host matchContents>
        <Menu label="" systemImage="ellipsis">
          <Button label="Run now" systemImage="play" onPress={() => void act(actions.runAutomation(a.id))} />
          {session && (
            <Button
              label="Open last session"
              systemImage="bubble.left"
              onPress={() => {
                setDorkId(session.id);
                router.navigate("/");
              }}
            />
          )}
        </Menu>
      </Host>
      <Switch value={a.enabled} onValueChange={(enabled) => void act(actions.updateAutomation(a.id, { enabled }))} />
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 20, paddingBottom: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, gap: 2 },
  title: { fontSize: size.ui },
  detail: { fontSize: size.small },
});
