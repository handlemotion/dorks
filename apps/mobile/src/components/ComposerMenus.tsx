import type { AgentModelChoice } from "@dorks/shared";
import { modelLabel } from "@dorks/shared";
import { Host, Menu, Picker, Section, Text as UIText } from "@expo/ui/swift-ui";
import { font, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, Text, View } from "react-native";
import { type as size, useColors } from "@/lib/theme";

// The compact bar under the composer: repository, model (with effort) and build, each a native SwiftUI menu. A value fixed for a
// session (its repository and build) shows as plain text.

const DEFAULT = "default";

/** A native menu whose label is the current value, small and muted, like the desktop's composer bar. */
function BarMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <Host matchContents>
      <Menu label={label} modifiers={[tint(c.muted), font({ size: size.small })]}>
        {children}
      </Menu>
    </Host>
  );
}

export function BarText({ children }: { children: string }) {
  const c = useColors();
  return (
    <Text numberOfLines={1} style={[s.text, { color: c.muted }]}>
      {children}
    </Text>
  );
}

export function ModelMenu({
  choices,
  model,
  effort,
  onChange,
}: {
  choices: AgentModelChoice[];
  model: string | undefined;
  effort: string | undefined;
  onChange: (model: string | null, effort: string | null) => void;
}) {
  const current = choices.find((m) => m.model === model);
  const efforts = current?.efforts ?? [];
  const label = [current ? modelLabel(current) : "Default model", effort && efforts.includes(effort as never) ? effort : undefined].filter(Boolean).join(" · ");
  if (!choices.length) return <BarText>{label}</BarText>;
  return (
    <BarMenu label={label}>
      <Section title="Model">
        <Picker selection={model ?? DEFAULT} onSelectionChange={(m: string) => onChange(m === DEFAULT ? null : m, null)}>
          <UIText modifiers={[tag(DEFAULT)]}>Default</UIText>
          {choices.map((m) => (
            <UIText key={m.model} modifiers={[tag(m.model)]}>
              {modelLabel(m)}
            </UIText>
          ))}
        </Picker>
      </Section>
      {efforts.length > 0 && (
        <Section title="Effort">
          <Picker selection={effort ?? DEFAULT} onSelectionChange={(e: string) => onChange(model ?? null, e === DEFAULT ? null : e)}>
            <UIText modifiers={[tag(DEFAULT)]}>Default</UIText>
            {efforts.map((e) => (
              <UIText key={e} modifiers={[tag(e)]}>
                {e}
              </UIText>
            ))}
          </Picker>
        </Section>
      )}
    </BarMenu>
  );
}

/** `""` is no repository: a plain chat (mode `chat`). */
export function RepoMenu({ repos, value, onChange }: { repos: string[]; value: string; onChange: (repo: string) => void }) {
  return (
    <BarMenu label={value ? (value.split("/")[1] ?? value) : "No repository"}>
      <Picker selection={value} onSelectionChange={(r: string) => onChange(r)}>
        <UIText modifiers={[tag("")]}>No repository</UIText>
        {repos.map((r) => (
          <UIText key={r} modifiers={[tag(r)]}>
            {r}
          </UIText>
        ))}
      </Picker>
    </BarMenu>
  );
}

/** `""` is the base machine. Only builds with an image can start a session. */
export function BuildMenu({ builds, value, onChange }: { builds: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <BarMenu label={builds.find((b) => b.id === value)?.name ?? "Base machine"}>
      <Picker selection={value} onSelectionChange={(id: string) => onChange(id)}>
        <UIText modifiers={[tag("")]}>Base machine</UIText>
        {builds.map((b) => (
          <UIText key={b.id} modifiers={[tag(b.id)]}>
            {b.name}
          </UIText>
        ))}
      </Picker>
    </BarMenu>
  );
}

export function MenuBar({ children }: { children: React.ReactNode }) {
  return <View style={s.bar}>{children}</View>;
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 18, minHeight: 28 },
  text: { fontSize: size.small, flexShrink: 1 },
});
