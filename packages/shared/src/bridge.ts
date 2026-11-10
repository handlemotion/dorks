import { z } from "zod";
import { notifyKind, prRef } from "./autonomy";

/**
 * An autonomy notification (docs/autonomy.md). Delivered and acked exactly like `user_message` (same dedupe by id), but the backend
 * only releases it at a turn boundary (never mid-turn) and never ahead of a pending user message. `text` is already wrapped in the
 * `<dorks-event>` envelope; the bridge writes it to stdin verbatim. `kinds`/`prs` are metadata for the bridge's hooks and logs.
 */
const notifyFrame = () =>
  z.object({ t: z.literal("notify"), id: z.string(), text: z.string(), kinds: z.array(notifyKind), prs: z.array(prRef) });

export const effortLevel = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof effortLevel>;
/** A model value the CLI accepts for `--model`: an alias (`opus`, `opus[1m]`) or a full id. */
export const modelValue = z.string().regex(/^[a-zA-Z0-9._:[\]-]{1,64}$/);
export const agentModelChoice = z.object({
  model: modelValue,
  name: z.string().max(80),
  description: z.string().max(200).optional(),
  /** The full id the alias resolves to today, when the CLI says. */
  resolved: modelValue.optional(),
  efforts: z.array(effortLevel),
});
export type AgentModelChoice = z.infer<typeof agentModelChoice>;

/** DO -> bridge (inside the box). */
export const toBridge = z.discriminatedUnion("t", [
  // `afterBridgeSeq` is the last `event.bseq` the DO has stored. The bridge MUST number new events from
  // max(its own counter, afterBridgeSeq) + 1 (a fresh box restarts at 0) and replay anything it has above afterBridgeSeq.
  z.object({ t: z.literal("hello"), afterBridgeSeq: z.number().int() }),
  // Sent on every bridge connect. Must be idempotent: if claude is already running with this config, only re-send `ready`.
  z.object({
    t: z.literal("configure"),
    provider: z.enum(["claude", "codex"]).optional(),
    codexModel: z.object({ model: z.string(), effort: z.string() }).optional(),
    // Claude: the model (a CLI alias such as `opus`, or a full id) and effort chosen in the UI; absent means the CLI's default.
    model: z.string().optional(),
    effort: z.string().optional(),
    env: z.record(z.string(), z.string()), // CLAUDE_CODE_OAUTH_TOKEN + CLI secrets: passed to the claude child, never written to disk
    ghToken: z.string(),
    repo: z.object({ fullName: z.string(), branch: z.string() }),
    resumeSessionId: z.string().nullable(),
    // Set while the dork still carries its first message as a title: the bridge asks a small model for a short name for this
    // text (once per bridge process) and sends it back as a `title` frame. Absent once the title was generated or typed.
    nameFrom: z.string().optional(),
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
  z.object({ t: z.literal("codex_issue"), message: z.string().max(1000) }),
  z.object({ t: z.literal("title"), text: z.string().min(1).max(120) }), // a generated name for the dork (see `nameFrom`)
  // Claude: the models the CLI offers this account (its `initialize` answer) and the effort the bridge started it with.
  z.object({ t: z.literal("agent_models"), models: z.array(agentModelChoice).max(100), effort: effortLevel.nullable() }),
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
