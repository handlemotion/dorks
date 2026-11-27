// Modes (docs/modes.md): what kind of session a dork is. One table every layer reads: the server checks a new or switched dork
// against it, the bridge picks the agent's instructions and crew role from it, and the app picks the new session's chooser from it.

export const DORK_MODES = ["code", "nerd"] as const;
export type DorkMode = (typeof DORK_MODES)[number];

export interface ModeSpec {
  /** The name the app shows. */
  label: string;
  /** One line for the picker. */
  description: string;
  /** A new session in this mode needs a repository (`owner/name`). The others start in an empty work directory. */
  needsRepo: boolean;
  /** Its role in a crew (docs/crew.md): a nerd is a coordinator. A worker's role comes from its parent, not its mode. */
  crewRole: "coordinator" | null;
}

export const MODES: Record<DorkMode, ModeSpec> = {
  code: { label: "Code", description: "Work in a repository and open pull requests", needsRepo: true, crewRole: null },
  nerd: { label: "Nerd", description: "Plan a goal and run sessions to reach it", needsRepo: false, crewRole: "coordinator" },
};

export const isDorkMode = (v: unknown): v is DorkMode => typeof v === "string" && (DORK_MODES as readonly string[]).includes(v);

/** A stored or sent mode, read leniently: the retired `chat` mode (and anything unknown) is a code session. */
export const dorkModeOf = (v: unknown): DorkMode => (isDorkMode(v) ? v : "code");
