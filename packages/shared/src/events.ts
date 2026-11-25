import { z } from "zod";
import { notifyKind, prRef } from "./autonomy";
import { appError, type AppError } from "./errors";

export const dorkState = z.enum(["creating", "working", "idle", "sleeping", "waking", "error"]);

/** What an agent may ask to do on the owner's computer: run a shell command, or read one text file. */
export const localKind = z.enum(["run", "read"]);
export type LocalKind = z.infer<typeof localKind>;

export const turnOutcome = z.enum(["done", "stopped", "failed"]);
export type TurnOutcome = z.infer<typeof turnOutcome>;

const base = { seq: z.number().int(), dorkId: z.string(), ts: z.number() };

export const clientEvent = z.discriminatedUnion("type", [
  // `from`: a message a coordinator dork sent its worker (docs/crew.md); absent for the owner's own messages.
  z.object({ ...base, type: z.literal("user_message"), text: z.string(), from: z.object({ id: z.string(), title: z.string() }).optional() }),
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
  // A crew report or note (docs/crew.md): `in` received from `peer`, `out` sent to it. A report is a worker's final answer.
  z.object({
    ...base,
    type: z.literal("crew"),
    direction: z.enum(["in", "out"]),
    peer: z.object({ id: z.string(), title: z.string() }),
    kind: z.enum(["report", "note"]),
    text: z.string(),
  }),
  // `source`: "preview" for the owner's preview comments (docs/architecture.md, "Preview comments"); absent for GitHub.
  z.object({ ...base, type: z.literal("notify"), kinds: z.array(notifyKind), prs: z.array(prRef), text: z.string(), source: z.literal("preview").optional() }),
  // A PR subscription changed (subscribed, ended, or stalled after CI_FIX_MAX_ATTEMPTS).
  z.object({ ...base, type: z.literal("subscription"), repo: z.string(), number: z.number(), status: z.enum(["active", "stalled", "ended"]), reason: z.string().optional() }),
  // Builds (docs/builds.md): the agent submitted a draft of its machine for the owner's approval, and the owner's answer.
  z.object({ ...base, type: z.literal("build_draft"), draftId: z.string(), buildId: z.string().nullable(), buildName: z.string(), note: z.string().optional() }),
  z.object({ ...base, type: z.literal("build_decision"), draftId: z.string(), buildId: z.string().nullable(), buildName: z.string(), approved: z.boolean(), reason: z.string().optional() }),
  // Local access (docs/local-access.md): the agent asked to run a command or read a file on the owner's own computer, the owner's
  // answer (asked once per session, or covered by an earlier answer), and what came back.
  z.object({
    ...base,
    type: z.literal("local_request"),
    requestId: z.string(),
    kind: localKind,
    command: z.string().optional(),
    cwd: z.string().optional(),
    path: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("local_decision"),
    requestId: z.string(),
    decision: z.enum(["allowed", "denied", "expired"]),
    // `session`: the owner allowed this session to use the computer; `always`: the owner allowed every session (the localAlwaysAllow
    // setting); `standing`: an earlier answer covered it. `once` and `grant` are per-command answers in transcripts from before.
    via: z.enum(["session", "always", "standing", "once", "grant"]).optional(),
  }),
  z.object({ ...base, type: z.literal("local_result"), requestId: z.string(), ok: z.boolean(), exitCode: z.number().nullable().optional(), preview: z.string(), truncated: z.boolean().optional() }),
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
