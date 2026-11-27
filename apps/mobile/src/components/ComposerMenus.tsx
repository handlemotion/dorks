import type { AgentModelChoice } from "@dorks/shared";
import { modelLabel } from "@dorks/shared";
import { Menu, Picker, Section, Text as UIText } from "@expo/ui/swift-ui";
import { tag } from "@expo/ui/swift-ui/modifiers";

// Submenus of the composer's + menu: repository, model (with effort) and build, each a native picker with the current value checked.

const DEFAULT = "default";

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
  if (!choices.length) return null;
  const efforts = choices.find((m) => m.model === model)?.efforts ?? [];
  return (
    <Menu label="Model" systemImage="cpu">
      <Section>
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
    </Menu>
  );
}

/** `""` is no repository: a nerd (mode `nerd`). */
export function RepoMenu({ repos, value, onChange }: { repos: string[]; value: string; onChange: (repo: string) => void }) {
  return (
    <Menu label="Repository" systemImage="folder">
      <Picker selection={value} onSelectionChange={(r: string) => onChange(r)}>
        <UIText modifiers={[tag("")]}>None (a nerd)</UIText>
        {repos.map((r) => (
          <UIText key={r} modifiers={[tag(r)]}>
            {r}
          </UIText>
        ))}
      </Picker>
    </Menu>
  );
}

/** `""` is the base machine. Only builds with an image can start a session. */
export function BuildMenu({ builds, value, onChange }: { builds: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  if (!builds.length) return null;
  return (
    <Menu label="Build" systemImage="shippingbox">
      <Picker selection={value} onSelectionChange={(id: string) => onChange(id)}>
        <UIText modifiers={[tag("")]}>Base machine</UIText>
        {builds.map((b) => (
          <UIText key={b.id} modifiers={[tag(b.id)]}>
            {b.name}
          </UIText>
        ))}
      </Picker>
    </Menu>
  );
}
