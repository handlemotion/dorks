import { z } from "zod";

/** DO -> bridge (inside the box). */
export const toBridge = z.discriminatedUnion("t", [
  // `afterBridgeSeq` is the last `event.bseq` the DO has stored. The bridge MUST number new events from
  // max(its own counter, afterBridgeSeq) + 1 (a fresh box restarts at 0) and replay anything it has above afterBridgeSeq.
  z.object({ t: z.literal("hello"), afterBridgeSeq: z.number().int() }),
  // Sent on every bridge connect. Must be idempotent: if claude is already running with this config, only re-send `ready`.
  z.object({
    t: z.literal("configure"),
    env: z.record(z.string(), z.string()), // CLAUDE_CODE_OAUTH_TOKEN + CLI secrets: passed to the claude child, never written to disk
    ghToken: z.string(),
    repo: z.object({ fullName: z.string(), branch: z.string() }),
    resumeSessionId: z.string().nullable(),
  }),
  z.object({ t: z.literal("user_message"), id: z.string(), text: z.string() }), // bridge dedupes by id
  z.object({ t: z.literal("interrupt") }),
  z.object({ t: z.literal("flush") }),
  z.object({ t: z.literal("gh_token"), token: z.string() }),
]);
export type ToBridge = z.infer<typeof toBridge>;

/** Bridge -> DO. */
export const fromBridge = z.discriminatedUnion("t", [
  z.object({ t: z.literal("event"), bseq: z.number().int(), raw: z.unknown() }), // raw claude stream-json line
  z.object({ t: z.literal("ready") }), // repo cloned + claude running
  z.object({ t: z.literal("ack"), id: z.string() }), // user_message id received
  z.object({ t: z.literal("agent_exited"), code: z.number().nullable(), stderrTail: z.string() }),
  z.object({ t: z.literal("flushed") }),
]);
export type FromBridge = z.infer<typeof fromBridge>;

/**
 * Convex transport only. `bridge.commands` is a reactive query, so its results must not carry secrets: `configure` and
 * `gh_token` appear as fetch markers, and the bridge calls the `bridge.configure` / `bridge.ghToken` actions to get the real frames above.
 */
export const commandFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("user_message"), id: z.string(), text: z.string() }),
  z.object({ t: z.literal("interrupt") }),
  z.object({ t: z.literal("flush") }),
  z.object({ t: z.literal("fetch_configure") }),
  z.object({ t: z.literal("fetch_gh_token") }),
]);
export type CommandFrame = z.infer<typeof commandFrame>;
