import { z } from "zod";
import { notifyKind, prRef } from "./autonomy";
import { appError, type AppError } from "./errors";

export const dorkState = z.enum(["creating", "working", "idle", "sleeping", "waking", "error"]);

export const turnOutcome = z.enum(["done", "stopped", "failed"]);
export type TurnOutcome = z.infer<typeof turnOutcome>;

const base = { seq: z.number().int(), dorkId: z.string(), ts: z.number() };

export const clientEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("user_message"), text: z.string() }),
  z.object({ ...base, type: z.literal("assistant_delta"), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal("assistant_message"), messageId: z.string(), text: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool_use"),
    toolId: z.string(),
    name: z.string(),
    summary: z.string(),
    // The call's arguments, each long string clipped: the progress panel shows them and draws an edit's diff from them. Absent on events
    // stored before calls kept their input.
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ ...base, type: z.literal("tool_result"), toolId: z.string(), ok: z.boolean(), preview: z.string() }),
  z.object({ ...base, type: z.literal("status"), state: dorkState }),
  // The end of an agent turn. `finalMessageId` names the turn's final answer: the last assistant message with no tool call after it,
  // stamped by the server from the agent's stream (clients never guess it from position). `outcome` is how the turn ended: `stopped`
  // after the user's Stop, `failed` when the agent reported an error. Both are absent on events stored before they existed.
  z.object({
    ...base,
    type: z.literal("turn_complete"),
    durationMs: z.number(),
    finalMessageId: z.string().optional(),
    outcome: turnOutcome.optional(),
  }),
  z.object({ ...base, type: z.literal("pr_opened"), url: z.string(), number: z.number() }),
  z.object({ ...base, type: z.literal("pr_merged"), url: z.string(), number: z.number() }),
  // An autonomy notification was handed to the agent (the transcript's event card). `text` is the human-readable digest, without the envelope.
  z.object({ ...base, type: z.literal("notify"), kinds: z.array(notifyKind), prs: z.array(prRef), text: z.string() }),
  // A PR subscription changed (subscribed, ended, or stalled after CI_FIX_MAX_ATTEMPTS).
  z.object({ ...base, type: z.literal("subscription"), repo: z.string(), number: z.number(), status: z.enum(["active", "stalled", "ended"]), reason: z.string().optional() }),
  // Builds (docs/builds.md): the agent submitted a draft of its machine for the owner's approval, and the owner's answer.
  z.object({ ...base, type: z.literal("build_draft"), draftId: z.string(), buildId: z.string().nullable(), buildName: z.string(), note: z.string().optional() }),
  z.object({ ...base, type: z.literal("build_decision"), draftId: z.string(), buildId: z.string().nullable(), buildName: z.string(), approved: z.boolean(), reason: z.string().optional() }),
  z.object({ ...base, type: z.literal("rate_limited"), resetsAt: z.number().optional() }),
  z.object({ ...base, type: z.literal("agent_exited"), message: z.string() }),
  // `error` is the typed form (absent on events stored before the taxonomy); `message` is always present for display.
  z.object({ ...base, type: z.literal("error"), message: z.string(), error: appError.optional() }),
]);

export type ClientEvent = z.infer<typeof clientEvent>;
export type DorkState = z.infer<typeof dorkState>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** An event before the server assigns seq / dorkId / ts. */
export type ClientEventBody = DistributiveOmit<ClientEvent, "seq" | "dorkId" | "ts">;

/** The `error` event for a typed error: `message` stays populated so older clients and stored-event readers keep working. */
export const errorEvent = (error: AppError): Extract<ClientEventBody, { type: "error" }> => ({ type: "error", message: error.message, error });
