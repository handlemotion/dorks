import type { DorkState } from "@dorks/shared";

// Pure lifecycle machine: (ctx, input) -> next state + effects. No I/O. `src/lifecycle/dispatch.ts` is the driver.
// Every (state, input) pair is handled explicitly; unknown combinations are no-ops, never throws.

export interface Ctx {
  state: DorkState;
  archived: boolean;
  hasBox: boolean;
  /** At least one user message or notify is persisted but not yet acknowledged by the bridge. */
  queued: boolean;
  /**
   * An unacked notify is held back for the next turn boundary and no user message is ahead of it (user messages always go first).
   * Absent = false.
   */
  notifyHeld?: boolean;
}

export type Input =
  | { t: "start" } // first-time creation, only valid in `creating` with no box
  | { t: "user_message" }
  | { t: "notify" } // an autonomy notification (docs/autonomy.md) was persisted; it wakes a sleeping dork like a message, but never lands mid-turn
  | { t: "agent_ready" }
  | { t: "turn_idle" }
  | { t: "sleep_due" }
  | { t: "paused" }
  | { t: "bridge_lost" }
  | { t: "agent_exited" }
  | { t: "op_failed" }
  | { t: "watchdog" }
  | { t: "archive" }
  | { t: "unarchive" }
  | { t: "interrupt" }
  | { t: "reconnect" };

export type Effect =
  | "create_box"
  | "resume_box"
  | "pause_box" // flush the bridge, then box.pause()
  | "cancel_pause" // drop a pending/in-flight pause: someone needs the box awake
  | "deliver_outbox"
  | "release_notify" // held notifies may now be emitted: a turn boundary, or a fresh agent
  | "interrupt_agent"
  | "arm_sleep"
  | "cancel_sleep"
  | "arm_watchdog"
  | "cancel_watchdog";

export interface Result {
  state: DorkState;
  archived: boolean;
  effects: Effect[];
  /** The input was refused (message or notify to an archived dork). Callers must not persist it. */
  rejected?: "archived";
}

const AWAKE: DorkState[] = ["creating", "working", "idle", "waking"];
const STOPPED: Effect[] = ["cancel_sleep", "cancel_watchdog"];
// A dork in `error` is not serving anyone, so its box must not keep running (and billing).
const FAILED = (c: Ctx): Effect[] => (c.hasBox ? [...STOPPED, "pause_box"] : STOPPED);

type Step = {
  /** Keep the state, apply these effects. */
  stay: (effects?: Effect[]) => Result;
  /** Move to `state` (and optionally change `archived`), apply these effects. */
  go: (state: DorkState, effects?: Effect[], archived?: boolean) => Result;
};
type Handler = (c: Ctx, s: Step, i: Input) => Result;

const onMessage: Handler = ({ archived, state, hasBox }, { stay, go }, i) => {
  if (archived) return { ...stay(), rejected: "archived" };
  switch (state) {
    case "creating":
    case "waking":
      return stay(); // already on its way up; the outbox delivers on ready
    case "working":
      return stay(i.t === "user_message" ? ["deliver_outbox"] : []); // a message steers mid-turn; a notify is held until `turn_idle`
    case "idle":
      return go("working", ["cancel_sleep", "cancel_pause", "deliver_outbox"]); // a sleep flush may be in flight
    case "sleeping":
      return go("waking", ["resume_box", "arm_watchdog"]);
    case "error":
      return hasBox ? go("waking", ["resume_box", "arm_watchdog"]) : go("creating", ["create_box", "arm_watchdog"]);
  }
  return stay();
};

const onAgentReady: Handler = (c, { stay, go }) => {
  if (c.state === "creating" || c.state === "waking") {
    if (c.archived) return go("idle", ["cancel_watchdog", "pause_box"]);
    // A fresh agent is between turns, so a notify that was held for the previous one can go out now.
    return c.queued ? go("working", ["cancel_watchdog", ...(c.notifyHeld ? ["release_notify" as const] : []), "deliver_outbox"]) : go("idle", ["cancel_watchdog", "arm_sleep"]);
  }
  // bridge reconnected after a blip: redeliver anything unacked
  if (c.state === "working" || c.state === "idle") return stay(["cancel_watchdog", "deliver_outbox"]);
  return stay();
};

const onTurnIdle: Handler = (c, { stay, go }) => {
  if (c.state !== "working") return stay();
  if (c.notifyHeld) return stay(["release_notify", "deliver_outbox"]); // the turn boundary a held notify waited for
  if (c.queued) return stay(["deliver_outbox"]); // a message is in flight; the next turn is about to start
  return go("idle", c.archived ? ["pause_box"] : ["arm_sleep"]);
};

const onFailure: Handler = (c, { stay, go }) => (AWAKE.includes(c.state) ? go("error", FAILED(c)) : stay());

const onArchive: Handler = (c, { stay, go }) => {
  if (c.archived) return stay();
  switch (c.state) {
    case "working":
      return go("working", ["interrupt_agent", "pause_box"], true);
    case "idle":
      return go("idle", ["cancel_sleep", "pause_box"], true);
    case "error":
      return go("error", c.hasBox ? ["pause_box"] : [], true);
    default:
      return go(c.state, [], true); // creating/waking: pauses on agent_ready; sleeping: already asleep
  }
};

const HANDLERS: Record<Input["t"], Handler> = {
  start: (c, { stay }) => (c.state === "creating" && !c.hasBox ? stay(["create_box", "arm_watchdog"]) : stay()),
  user_message: onMessage,
  notify: onMessage,
  agent_ready: onAgentReady,
  turn_idle: onTurnIdle,
  sleep_due: (c, { stay }) => (c.state === "idle" && !c.queued ? stay(["pause_box"]) : stay()),
  paused: (c, { stay, go }) => (AWAKE.includes(c.state) || c.state === "error" ? go("sleeping", STOPPED) : stay()),
  bridge_lost: (c, { stay }) => (AWAKE.includes(c.state) ? stay(["arm_watchdog"]) : stay()),
  agent_exited: onFailure,
  op_failed: onFailure,
  watchdog: onFailure,
  archive: onArchive,
  unarchive: (c, { go }) => go(c.state, [], false), // never wakes
  interrupt: (c, { stay }) => (c.state === "working" ? stay(["interrupt_agent"]) : stay()),
  reconnect: (c, { stay, go }) => (c.state === "idle" ? go("waking", ["cancel_sleep", "arm_watchdog"]) : stay()),
};

export function reduce(c: Ctx, i: Input): Result {
  const stay = (effects: Effect[] = []): Result => ({ state: c.state, archived: c.archived, effects });
  const go = (state: DorkState, effects: Effect[] = [], archived = c.archived): Result => ({ state, archived, effects });
  return HANDLERS[i.t](c, { stay, go }, i);
}
