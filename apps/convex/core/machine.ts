import type { DorkState } from "@dorks/shared";

// Pure lifecycle machine: (ctx, input) -> next state + effects. No I/O. `convex/lib/dispatch.ts` is the driver.
// Every (state, input) pair is handled explicitly; unknown combinations are no-ops, never throws.

export interface Ctx {
  state: DorkState;
  archived: boolean;
  hasBox: boolean;
  /** At least one user message is persisted but not yet acknowledged by the bridge. */
  queued: boolean;
}

export type Input =
  | { t: "start" } // first-time creation, only valid in `creating` with no box
  | { t: "user_message" }
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
  | { t: "interrupt" };

export type Effect =
  | "create_box"
  | "resume_box"
  | "pause_box" // flush the bridge, then box.pause()
  | "cancel_pause" // drop a pending/in-flight pause: someone needs the box awake
  | "deliver_outbox"
  | "interrupt_agent"
  | "arm_sleep"
  | "cancel_sleep"
  | "arm_watchdog"
  | "cancel_watchdog"
  | "arm_gh_refresh"
  | "cancel_gh_refresh";

export interface Result {
  state: DorkState;
  archived: boolean;
  effects: Effect[];
  /** The input was refused (message to an archived dork). Callers must not persist the message. */
  rejected?: "archived";
}

const AWAKE: DorkState[] = ["creating", "working", "idle", "waking"];
const STOPPED: Effect[] = ["cancel_sleep", "cancel_watchdog", "cancel_gh_refresh"];
// A dork in `error` is not serving anyone, so its box must not keep running (and billing).
const FAILED = (c: Ctx): Effect[] => (c.hasBox ? [...STOPPED, "pause_box"] : STOPPED);

export function reduce(c: Ctx, i: Input): Result {
  const stay = (effects: Effect[] = []): Result => ({ state: c.state, archived: c.archived, effects });
  const go = (state: DorkState, effects: Effect[] = [], archived = c.archived): Result => ({ state, archived, effects });

  switch (i.t) {
    case "start":
      return c.state === "creating" && !c.hasBox ? stay(["create_box", "arm_watchdog"]) : stay();

    case "user_message": {
      if (c.archived) return { ...stay(), rejected: "archived" };
      switch (c.state) {
        case "creating":
        case "waking":
          return stay(); // already on its way up; the outbox delivers on ready
        case "working":
          return stay(["deliver_outbox"]); // steer mid-turn
        case "idle":
          return go("working", ["cancel_sleep", "cancel_pause", "deliver_outbox"]); // a sleep flush may be in flight
        case "sleeping":
          return go("waking", ["resume_box", "arm_watchdog"]);
        case "error":
          return c.hasBox ? go("waking", ["resume_box", "arm_watchdog"]) : go("creating", ["create_box", "arm_watchdog"]);
      }
      return stay();
    }

    case "agent_ready":
      if (c.state === "creating" || c.state === "waking") {
        if (c.archived) return go("idle", ["cancel_watchdog", "pause_box"]);
        return c.queued
          ? go("working", ["cancel_watchdog", "arm_gh_refresh", "deliver_outbox"])
          : go("idle", ["cancel_watchdog", "arm_gh_refresh", "arm_sleep"]);
      }
      // bridge reconnected after a blip: redeliver anything unacked
      if (c.state === "working" || c.state === "idle") return stay(["cancel_watchdog", "deliver_outbox"]);
      return stay();

    case "turn_idle":
      if (c.state !== "working") return stay();
      if (c.queued) return stay(["deliver_outbox"]); // a message is in flight; the next turn is about to start
      return go("idle", c.archived ? ["pause_box"] : ["arm_sleep"]);

    case "sleep_due":
      return c.state === "idle" && !c.queued ? stay(["pause_box"]) : stay();

    case "paused":
      return AWAKE.includes(c.state) || c.state === "error" ? go("sleeping", STOPPED) : stay();

    case "bridge_lost":
      return AWAKE.includes(c.state) ? stay(["arm_watchdog"]) : stay();

    case "agent_exited":
    case "op_failed":
    case "watchdog":
      return AWAKE.includes(c.state) ? go("error", FAILED(c)) : stay();

    case "archive": {
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
    }

    case "unarchive":
      return go(c.state, [], false); // never wakes

    case "interrupt":
      return c.state === "working" ? stay(["interrupt_agent"]) : stay();
  }
}
