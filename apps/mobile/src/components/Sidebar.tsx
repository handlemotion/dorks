import { useDorks, useOptionalDorksClient } from "@dorks/client/react";
import type { Dork } from "@dorks/client";
import { Host, Menu, Picker, Text as UIText } from "@expo/ui/swift-ui";
import { tag } from "@expo/ui/swift-ui/modifiers";
import { useRouter } from "expo-router";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShell } from "@/components/Shell";
import { useCurrentChat } from "@/lib/chat";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

function Row({ icon, label, onPress, selected, detail }: { icon?: SFSymbol; label: string; onPress: () => void; selected?: boolean; detail?: string }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, { backgroundColor: selected || pressed ? c.selected : "transparent" }]}>
      {icon && <SymbolView name={icon} size={17} tintColor={c.text} />}
      <Text numberOfLines={1} style={[s.label, { color: c.text }]}>
        {label}
      </Text>
      {detail && <Text style={[s.detail, { color: c.muted }]}>{detail}</Text>}
    </Pressable>
  );
}

function ChatsTitle() {
  const c = useColors();
  return useDorks()?.length ? <Text style={[s.section, { color: c.muted }]}>Chats</Text> : null;
}

function ChatList({ onOpen }: { onOpen: (id: string) => void }) {
  const dorks = useDorks();
  const { dorkId } = useCurrentChat();
  if (!dorks) return null;
  return dorks.map((d: Dork) => <Row key={d.id} label={d.title || "New chat"} detail={d.state === "working" ? "…" : undefined} selected={d.id === dorkId} onPress={() => onOpen(d.id)} />);
}

/** The Mac the app talks to, switchable when more than one is paired. */
function MacMenu() {
  const c = useColors();
  const { macs, mac, select } = useMacs();
  if (!mac) return null;
  const label = mac.name;
  if (!macs || macs.length < 2)
    return (
      <View style={s.macRow}>
        <View style={[s.dot, { backgroundColor: mac.online ? c.open : c.draft }]} />
        <Text style={[s.mac, { color: c.muted }]}>{label}</Text>
      </View>
    );
  return (
    <Host matchContents>
      <Menu label={label}>
        <Picker selection={mac.id} onSelectionChange={(id: string) => select(id)}>
          {macs.map((m) => (
            <UIText key={m.id} modifiers={[tag(m.id)]}>
              {m.name}
            </UIText>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}

/** Under the sliding app: New chat, the pages, then the chats (the desktop sidebar's sessions). */
export function Sidebar() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const shell = useShell();
  const { setDorkId } = useCurrentChat();
  const client = useOptionalDorksClient();
  const go = (path: "/" | "/customize" | "/automations" | "/settings") => {
    shell.close();
    if (path === "/settings") router.push(path);
    else router.navigate(path);
  };
  const openChat = (id: string | null) => {
    setDorkId(id);
    go("/");
  };
  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <View style={s.head}>
        <Text style={[s.title, { color: c.text }]}>Dorks</Text>
        <MacMenu />
      </View>
      <View style={s.group}>
        {client && <Row icon="square.and.pencil" label="New chat" onPress={() => openChat(null)} />}
        {client && <Row icon="square.grid.2x2" label="Plugins" onPress={() => go("/customize")} />}
        {client && <Row icon="clock" label="Automations" onPress={() => go("/automations")} />}
        <Row icon="gearshape" label="Settings" onPress={() => go("/settings")} />
      </View>
      {client && (
        <>
          <ChatsTitle />
          <ScrollView contentContainerStyle={[s.group, { paddingBottom: insets.bottom + 16 }]}>
            <ChatList onOpen={openChat} />
          </ScrollView>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 12 },
  head: { paddingHorizontal: 8, paddingBottom: 16, gap: 2, alignItems: "flex-start" },
  title: { fontSize: 22, fontWeight: "500" },
  mac: { fontSize: size.small },
  group: { gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 44, paddingHorizontal: 10, borderRadius: radius.control },
  label: { flex: 1, fontSize: size.ui },
  detail: { fontSize: size.small },
  section: { fontSize: size.small, paddingHorizontal: 10, paddingTop: 20, paddingBottom: 6 },
  macRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
