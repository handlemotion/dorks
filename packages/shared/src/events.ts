import { z } from "zod";
import { notifyKind, prRef } from "./autonomy";

export const dorkState = z.enum(["creating", "working", "idle", "sleeping", "waking", "error"]);

const base = { seq: z.number().int(), dorkId: z.string(), ts: z.number() };

export const clientEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("user_message"), text: z.string() }),
  z.object({ ...base, type: z.literal("assistant_delta"), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal("assistant_message"), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal("tool_use"), toolId: z.string(), name: z.string(), summary: z.string() }),
  z.object({ ...base, type: z.literal("tool_result"), toolId: z.string(), ok: z.boolean(), preview: z.string() }),
  z.object({ ...base, type: z.literal("status"), state: dorkState }),
  z.object({ ...base, type: z.literal("turn_complete"), durationMs: z.number() }),
  z.object({ ...base, type: z.literal("pr_opened"), url: z.string(), number: z.number() }),
  z.object({ ...base, type: z.literal("pr_merged"), url: z.string(), number: z.number() }),
  // An autonomy notification was handed to the agent (the transcript's event card). `text` is the human-readable digest, without the envelope.
  z.object({ ...base, type: z.literal("notify"), kinds: z.array(notifyKind), prs: z.array(prRef), text: z.string() }),
  // A PR subscription changed (subscribed, ended, or stalled after CI_FIX_MAX_ATTEMPTS).
  z.object({ ...base, type: z.literal("subscription"), repo: z.string(), number: z.number(), status: z.enum(["active", "stalled", "ended"]), reason: z.string().optional() }),
  z.object({ ...base, type: z.literal("rate_limited"), resetsAt: z.number().optional() }),
  z.object({ ...base, type: z.literal("agent_exited"), message: z.string() }),
  z.object({ ...base, type: z.literal("error"), message: z.string() }),
]);

export type ClientEvent = z.infer<typeof clientEvent>;
export type DorkState = z.infer<typeof dorkState>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** An event before the server assigns seq / dorkId / ts. */
export type ClientEventBody = DistributiveOmit<ClientEvent, "seq" | "dorkId" | "ts">;
