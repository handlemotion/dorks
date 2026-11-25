import type { SkillResolution, SkillView } from "@dorks/shared";
import { useComposio, useDorksClient, useMcpServers, useSkills } from "@dorks/client/react";
import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { SymbolView } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Header } from "@/components/Header";
import { errorText } from "@/lib/format";
import { radius, type as size, useColors } from "@/lib/theme";

// Plugins: skills (install from a source, update, remove), then MCP servers and connected apps, read only for v1.

function Section({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: c.muted }]}>{title}</Text>
      <View style={[s.rows, { borderTopColor: c.hairline }]}>{children}</View>
    </View>
  );
}

function Row({ title, detail, right }: { title: string; detail?: string; right?: ReactNode }) {
  const c = useColors();
  return (
    <View style={[s.row, { borderBottomColor: c.hairline }]}>
      <View style={s.rowText}>
        <Text numberOfLines={1} style={[s.rowTitle, { color: c.text }]}>
          {title}
        </Text>
        {detail ? (
          <Text numberOfLines={2} style={[s.detail, { color: c.muted }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

function Empty({ children }: { children: string }) {
  const c = useColors();
  return <Text style={[s.empty, { color: c.muted }]}>{children}</Text>;
}

function SkillRow({ skill, onError }: { skill: SkillView; onError: (e: string | undefined) => void }) {
  const c = useColors();
  const { actions } = useDorksClient();
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    onError(undefined);
    try {
      await job();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = () =>
    Alert.alert(`Remove ${skill.name}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void run(() => actions.deleteSkill(skill.name)) },
    ]);
  return (
    <Row
      title={skill.name}
      detail={skill.description || skill.source.repo}
      right={
        busy ? (
          <ActivityIndicator color={c.muted} />
        ) : (
          <Host matchContents>
            <Menu label="" systemImage="ellipsis">
              <Button label="Update" systemImage="arrow.clockwise" onPress={() => void run(() => actions.updateSkill(skill.name))} />
              <Button label="Remove" systemImage="trash" role="destructive" onPress={remove} />
            </Menu>
          </Host>
        )
      }
    />
  );
}

/** Paste a source (`owner/repo`, a GitHub URL, an `npx skills add` command), pick its skills, install them. */
function InstallSkills() {
  const c = useColors();
  const { actions } = useDorksClient();
  const [source, setSource] = useState("");
  const [found, setFound] = useState<SkillResolution>();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const find = () =>
    run(async () => {
      const r = await actions.resolveSkills(source.trim());
      setFound(r);
      setPicked(r.requested.length ? r.requested : r.skills.length === 1 ? [r.skills[0].name] : []);
    });
  const install = () =>
    run(async () => {
      await actions.installSkills(source.trim(), picked);
      setFound(undefined);
      setSource("");
    });
  const toggle = (name: string) => setPicked((xs) => (xs.includes(name) ? xs.filter((x) => x !== name) : [...xs, name]));

  return (
    <View style={s.install}>
      <View style={s.inputRow}>
        <TextInput
          value={source}
          onChangeText={(t) => {
            setSource(t);
            setFound(undefined);
          }}
          placeholder="owner/repo or a GitHub link"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => source.trim() && void find()}
          style={[s.input, { color: c.text, backgroundColor: c.fill }]}
        />
        <Pressable disabled={!source.trim() || busy} onPress={() => void (found ? install() : find())} style={[s.button, { backgroundColor: c.text, opacity: !source.trim() || busy ? 0.4 : 1 }]}>
          <Text style={[s.buttonText, { color: c.background }]}>{found ? `Install${picked.length ? ` ${picked.length}` : ""}` : "Find"}</Text>
        </Pressable>
      </View>
      {busy && <ActivityIndicator color={c.muted} />}
      {error && <Text style={[s.detail, { color: c.danger }]}>{error}</Text>}
      {found?.skills.map((k) => (
        <Pressable key={k.name} onPress={() => toggle(k.name)} style={s.candidate}>
          <SymbolView name={picked.includes(k.name) ? "checkmark.circle.fill" : "circle"} size={20} tintColor={picked.includes(k.name) ? c.brand : c.muted} />
          <View style={s.rowText}>
            <Text style={[s.rowTitle, { color: c.text }]}>
              {k.name}
              {k.installed ? <Text style={{ color: c.muted }}> (installed)</Text> : null}
            </Text>
            <Text numberOfLines={2} style={[s.detail, { color: c.muted }]}>
              {k.description}
            </Text>
          </View>
        </Pressable>
      ))}
      {found && !found.skills.length && <Empty>No skills found</Empty>}
    </View>
  );
}

export default function CustomizeTab() {
  const c = useColors();
  const skills = useSkills();
  const servers = useMcpServers();
  const composio = useComposio();
  const [error, setError] = useState<string>();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <Header />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.body} keyboardDismissMode="interactive">
        <Section title="Skills">
          {skills === undefined ? <ActivityIndicator color={c.muted} /> : skills.map((k) => <SkillRow key={k.name} skill={k} onError={setError} />)}
          {error && <Text style={[s.detail, { color: c.danger }]}>{error}</Text>}
          <InstallSkills />
        </Section>
        {servers?.length ? (
          <Section title="MCP servers">
            {servers.map((m) => (
              <Row
                key={m.name}
                title={m.name}
                detail={m.transport === "http" ? (m.url ?? "") : [m.command, ...m.args].filter(Boolean).join(" ")}
                right={m.oauth === "signed_out" ? <Text style={[s.detail, { color: c.muted }]}>Signed out</Text> : undefined}
              />
            ))}
          </Section>
        ) : null}
        {composio?.connected && composio.toolkits.length ? (
          <Section title="Connected apps">
            {composio.toolkits.map((t) => (
              <Row key={t} title={t} />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 20, gap: 28 },
  section: { gap: 8 },
  sectionTitle: { fontSize: size.small },
  rows: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: size.ui },
  detail: { fontSize: size.small, lineHeight: 18 },
  empty: { fontSize: size.ui, paddingVertical: 12 },
  install: { gap: 10, paddingTop: 12 },
  inputRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, height: 40, borderRadius: radius.control, paddingHorizontal: 12, fontSize: size.ui },
  button: { height: 40, borderRadius: radius.control, paddingHorizontal: 14, justifyContent: "center" },
  buttonText: { fontSize: size.ui, fontWeight: "500" },
  candidate: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
});
