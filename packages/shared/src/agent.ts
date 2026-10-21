import { z } from "zod";

/**
 * The agent harness a dork runs: the program that gives the model its tools and runs its loop. Chosen when the dork is created and
 * fixed for its life, because a session belongs to one harness (a Claude Code transcript cannot be resumed by OpenCode).
 */
export const engine = z.enum(["claude", "opencode"]);
export type Engine = z.infer<typeof engine>;
export const DEFAULT_ENGINE: Engine = "claude";
export const ENGINE_LABEL: Record<Engine, string> = { claude: "Claude Code", opencode: "OpenCode" };

/** An OpenCode model reference, `<provider>/<model>` as OpenCode's config takes it (e.g. `anthropic/claude-sonnet-4-5`). */
export const OPENCODE_MODEL_RE = /^[A-Za-z0-9][\w.-]{0,63}\/[\w.:@/-]{1,128}$/;

/**
 * Harness-neutral agent events: the common format every harness except Claude Code speaks. The bridge's adapter for a harness turns
 * that harness's own stream into these; the backend normalizer (apps/convex/core/normalize.ts) turns them into client events.
 * Claude Code keeps sending its own stream-json, which the normalizer reads directly (bridges already baked into box snapshots do).
 */
export const agentEvent = z.discriminatedUnion("type", [
  // The harness's session id, as the bridge must hand it back to resume (stored as `dorks.claudeSessionId`).
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  // The agent is between turns: what Claude's `session_state_changed: idle` means.
  z.object({ type: z.literal("idle") }),
  // Streaming text of an assistant message, then the complete text (which replaces the streamed partials).
  z.object({ type: z.literal("text_delta"), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal("text"), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal("tool_use"), toolId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), toolId: z.string(), ok: z.boolean(), output: z.string() }),
  // One user turn finished. `error` is set when it failed (provider auth, API error, aborted).
  z.object({ type: z.literal("turn_complete"), durationMs: z.number(), error: z.string().optional() }),
  z.object({ type: z.literal("rate_limited"), resetsAt: z.number().optional() }),
]);
export type AgentEvent = z.infer<typeof agentEvent>;

/** An agent event in a bridge `event` frame's `raw`, tagged so the backend can tell it from a Claude stream-json line. */
export const AGENT_EVENT_TYPE = "dorks_agent";
export const agentEventRaw = z.object({ type: z.literal(AGENT_EVENT_TYPE), event: agentEvent });
export const toRaw = (event: AgentEvent) => ({ type: AGENT_EVENT_TYPE, event });
