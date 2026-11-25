// Modes (docs/modes.md): what kind of session a dork is. One table every layer reads: the server checks a new or switched dork
// against it, the bridge picks the agent's instructions, hooks and in-box tools from it, and the app shows the mode picker from it.

export const DORK_MODES = ["chat", "code", "nerd"] as const;
export type DorkMode = (typeof DORK_MODES)[number];

export interface ModeSpec {
  /** The name the app shows. */
  label: string;
  /** One line for the picker. */
  description: string;
  /** A new session in this mode needs a repository (`owner/name`). The others start in an empty work directory. */
  needsRepo: boolean;
  /**
   * Coding autonomy: the Stop gate that blocks finishing with unshipped work, the PR subscription context at session start, and the
   * `pr_*` tools. Off for a conversation, where nothing ships as a pull request.
   */
  autonomy: boolean;
  /** Its role in a crew (docs/crew.md): a nerd is a coordinator. A worker's role comes from its parent, not its mode. */
  crewRole: "coordinator" | null;
}

export const MODES: Record<DorkMode, ModeSpec> = {
  chat: { label: "Chat", description: "Talk, write and research, on its own computer", needsRepo: false, autonomy: false, crewRole: null },
  code: { label: "Code", description: "Work in a repository and open pull requests", needsRepo: true, autonomy: true, crewRole: null },
  nerd: { label: "Nerd", description: "Plan a goal and run sessions to reach it", needsRepo: false, autonomy: true, crewRole: "coordinator" },
};

export const isDorkMode = (v: unknown): v is DorkMode => typeof v === "string" && (DORK_MODES as readonly string[]).includes(v);
