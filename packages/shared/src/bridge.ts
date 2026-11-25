import { z } from "zod";
import { mcpServerConfig } from "./mcp";
import { skillRef } from "./skills";
import { agentCommand, filePath, MAX_AGENT_COMMANDS, MAX_FILE_PATHS } from "./mentions";
import { notifyKind, prRef } from "./autonomy";
import { buildService, MAX_BUILD_SERVICES } from "./builds";
import { DORK_MODES } from "./modes";

/**
 * An autonomy notification (docs/autonomy.md). Delivered and acked exactly like `user_message` (same dedupe by id), but the backend
 * only releases it at a turn boundary (never mid-turn) and never ahead of a pending user message. `text` is already wrapped in the
 * `<dorks-event>` envelope; the bridge writes it to stdin verbatim. `kinds`/`prs` are metadata for the bridge's hooks and logs.
 */
const notifyFrame = () => z.object({ t: z.literal("notify"), id: z.string(), text: z.string(), kinds: z.array(notifyKind), prs: z.array(prRef) });

export const effortLevel = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof effortLevel>;
/** A model value the CLI accepts for `--model`: an alias (`opus`, `opus[1m]`) or a full id; for OpenCode, `provider/model`. */
export const modelValue = z.string().regex(/^[a-zA-Z0-9._:[\]-]{1,64}(?:\/[a-zA-Z0-9._:[\]/-]{1,128})?$/);
export const agentModelChoice = z.object({
  model: modelValue,
  name: z.string().max(80),
  description: z.string().max(200).optional(),
  /** The full id the alias resolves to today, when the CLI says. */
  resolved: modelValue.optional(),
  efforts: z.array(effortLevel),
  /** The model offers fast mode (the CLI's `supportsFastMode`). */
  fast: z.boolean().optional(),
});
export type AgentModelChoice = z.infer<typeof agentModelChoice>;

/** `claude-opus-5-5` -> `Opus 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`, `claude-opus-5` -> `Opus 5`; anything else: undefined. */
export function versionedName(id: string | undefined): string | undefined {
  const m = id && /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return undefined;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/**
 * A model's name with its version: older CLIs (and lists stored from them) name an alias by its family alone ("Opus"), so it is named
 * by the model it resolves to ("Opus 5.5") instead. The `default` alias keeps its own name.
 */
export function modelLabel(choice: Pick<AgentModelChoice, "model" | "name" | "resolved">): string {
  if (choice.model === "default" || /\d/.test(choice.name)) return choice.name;
  return versionedName(choice.resolved) ?? versionedName(choice.model) ?? choice.name;
}

/** DO -> bridge (inside the box). */
export const toBridge = z.discriminatedUnion("t", [
  // `afterBridgeSeq` is the last `event.bseq` the DO has stored. The bridge MUST number new events from
  // max(its own counter, afterBridgeSeq) + 1 (a fresh box restarts at 0) and replay anything it has above afterBridgeSeq.
  z.object({ t: z.literal("hello"), afterBridgeSeq: z.number().int() }),
  // Sent on every bridge connect. Must be idempotent: if claude is already running with this config, only re-send `ready`.
  z.object({
    t: z.literal("configure"),
    provider: z.enum(["claude", "codex", "opencode", "antigravity"]).optional(),
    codexModel: z.object({ model: z.string(), effort: z.string() }).optional(),
    // Claude: the model (a CLI alias such as `opus`, or a full id) and effort chosen in the UI; absent means the CLI's default.
    // OpenCode: `provider/model` (`opencode/deepseek-v4.1-flash`); absent means OpenCode's own default.
    // Antigravity: a slug from `agy models` (`gemini-4-neon-high`); absent means agy's own default.
    model: z.string().optional(),
    effort: z.string().optional(),
    // Claude: fast mode on (the `fastMode` setting); only sent for a model that offers it.
    fast: z.boolean().optional(),
    // Claude: Code Mode on (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE in the --settings env block); fixed when the dork is created.
    codeMode: z.boolean().optional(),
    env: z.record(z.string(), z.string()), // CLAUDE_CODE_OAUTH_TOKEN + shared and build variables: passed to the agent child, never written to disk
    ghToken: z.string(),
    // null: a session with no starting repo (a machine-setup session, docs/builds.md): the agent starts in the work directory.
    repo: z.object({ fullName: z.string(), branch: z.string() }).nullable(),
    resumeSessionId: z.string().nullable(),
    // Set while the dork still carries its first message as a title: the bridge asks a small model for a short name for this
    // text (once per bridge process) and sends it back as a `title` frame. Absent once the title was generated or typed.
    nameFrom: z.string().optional(),
    // The owner's MCP servers (Customize, see mcp.ts), added to the agent's next to `dorks`. Absent from an older server: none.
    mcpServers: z.array(mcpServerConfig).max(50).optional(),
    // The dork's place in a crew (docs/crew.md): its guidance and which crew tools the in-box MCP server lists. Absent: a plain dork.
    role: z.enum(["coordinator", "worker"]).optional(),
    // The dork's mode (docs/modes.md): its instructions, hooks and in-box tools. Absent from an older server: code.
    mode: z.enum(DORK_MODES).optional(),
    // The owner's skills (Customize, see skills.ts): the bridge keeps ~/.claude/skills in step, fetching changed ones with the `skill`
    // rpc. Absent from an older server: none. Not part of the agent's restart key: Claude Code reloads skills by itself.
    skills: z.array(skillRef).max(200).optional(),
    // The dork's build's services (docs/services.md): what `service_start` can start. Absent: none (base machine, or an older server).
    services: z.array(buildService).max(MAX_BUILD_SERVICES).optional(),
  }),
  z.object({ t: z.literal("user_message"), id: z.string(), text: z.string() }), // bridge dedupes by id
  notifyFrame(),
  z.object({ t: z.literal("interrupt") }),
  z.object({ t: z.literal("flush") }),
  z.object({ t: z.literal("gh_token"), token: z.string() }),
]);
export type ToBridge = z.infer<typeof toBridge>;

/** Bridge -> DO. */
export const fromBridge = z.discriminatedUnion("t", [
  z.object({ t: z.literal("event"), bseq: z.number().int(), raw: z.unknown() }), // raw claude stream-json line
  z.object({ t: z.literal("codex_models"), models: z.array(z.object({ model: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), efforts: z.array(effortLevel) })).max(100) }),
  // Codex, OpenCode or Antigravity could not run a turn (sign-in, a provider key, a used-up plan): shown in the thread as an error.
  z.object({ t: z.literal("codex_issue"), message: z.string().max(1000) }),
  z.object({ t: z.literal("title"), text: z.string().min(1).max(120) }), // a generated name for the dork (see `nameFrom`)
  // Claude: the models the CLI offers this account (its `initialize` answer) and the effort the bridge started it with.
  // OpenCode: every `provider/model` its configured providers offer, with no efforts. Antigravity: `agy models`, with no efforts.
  z.object({ t: z.literal("agent_models"), models: z.array(agentModelChoice).max(100), effort: effortLevel.nullable() }),
  // Claude: the slash commands and skills the CLI offers this session (its `initialize` answer), for the composer's `/` menu.
  z.object({ t: z.literal("agent_commands"), commands: z.array(agentCommand).max(MAX_AGENT_COMMANDS) }),
  // The repository's files (`git ls-files`, tracked and untracked but not ignored), for the composer's `@` menu. Sent when the
  // listing changes; `truncated` when there were more than fit.
  z.object({ t: z.literal("files"), paths: z.array(filePath).max(MAX_FILE_PATHS), truncated: z.boolean() }),
  z.object({ t: z.literal("ready") }), // repo cloned + claude running
  z.object({ t: z.literal("ack"), id: z.string() }), // user_message id received
  z.object({ t: z.literal("agent_exited"), code: z.number().nullable(), stderrTail: z.string() }),
  // `cid` is the cid of the `flush` command this answers (the same id the bridge acks). Optional for compatibility: a `flushed`
  // without it is accepted as the answer to the current flush, but a stale one can then end a later flush early.
  z.object({ t: z.literal("flushed"), cid: z.string().optional() }),
]);
export type FromBridge = z.infer<typeof fromBridge>;

/**
 * Frames the server pushes on the bridge socket. They must not carry secrets: `configure` appears as a fetch marker, and the bridge
 * asks for the real frame above with a `configure` request on the authenticated socket (see docs/architecture.md).
 */
export const commandFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("user_message"), id: z.string(), text: z.string() }),
  notifyFrame(),
  z.object({ t: z.literal("interrupt") }),
  z.object({ t: z.literal("flush") }),
  z.object({ t: z.literal("fetch_configure") }),
  z.object({ t: z.literal("fetch_gh_token") }),
]);
export type CommandFrame = z.infer<typeof commandFrame>;
