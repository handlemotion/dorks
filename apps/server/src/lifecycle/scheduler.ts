import { Cause, Effect, Fiber, FiberSet, Latch, Scope } from "effect";
import type { App, SchedulerLike } from "../app";
import { hasTimer, setTimer } from "./dispatch";
import { isJob, runJob } from "./jobs";
import { fireTimer } from "./lifecycle";
import { recoverSnapshotBuild } from "../services/snapshot";
import { recoverBuildRuns } from "../services/buildRuns";
import { pollable } from "../services/subscriptions";

interface TimerRow {
  owner: string;
  name: string;
  due_at: number;
  payload: string | null;
}

const MAX_SLEEP_MS = 60_000; // re-check at least this often: a wall-clock jump must not strand a timer

const errorText = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  return e instanceof Error ? e.message.slice(0, 200) : "unknown";
};

/**
 * Fires the durable timers table. State-machine timers run synchronously in one transaction with their claim; jobs (provider
 * calls) are claimed in a transaction and then run concurrently, each a fiber in one `FiberSet`. A timer is claimed by deleting
 * its row, so it fires at most once; on boot everything already due fires at once.
 *
 * The loop is one Effect fiber: it fires what is due, then sleeps until the next due time, the `MAX_SLEEP_MS` cap, or a `wake()`
 * (a `Latch` it closes before each pass, so a wake that lands mid-pass is not lost). `stop()` interrupts the loop; jobs already
 * running finish, and `idle()` waits for them.
 */
export class Scheduler implements SchedulerLike {
  private readonly scope = Scope.makeUnsafe();
  private readonly jobs: FiberSet.FiberSet<void, never> = Effect.runSync(FiberSet.make<void, never>().pipe(Scope.provide(this.scope)));
  private readonly woken = Latch.makeUnsafe(false);
  private loop?: Fiber.Fiber<never, never>;

  constructor(private readonly app: App) {}

  start() {
    if (this.loop) return;
    this.app.scheduler = this;
    this.recover();
    this.loop = Effect.runFork(this.run());
  }

  /**
   * Picks up what a restart interrupted. Timers are durable, but a job is claimed (its row deleted) before it runs, so a crash
   * mid-job loses it: a delete in flight would leave a hidden dork and its sandbox behind forever.
   */
  recover() {
    const { app } = this;
    if (pollable(app).length && !hasTimer(app, "", "poll")) setTimer(app, "", "poll", 1_000); // keep watching PRs subscribed before the restart
    for (const d of app.db.all<{ id: string }>("SELECT id FROM dorks WHERE deleting = 1")) if (!hasTimer(app, d.id, "box:destroy")) setTimer(app, d.id, "box:destroy", 0);
    if (!hasTimer(app, "", "sweep")) setTimer(app, "", "sweep", 60_000);
    recoverSnapshotBuild(app); // a build that was running when the process died runs again, as a new attempt
    recoverBuildRuns(app); // likewise for build runs (docs/builds.md)
  }

  stop() {
    const loop = this.loop;
    this.loop = undefined;
    if (loop) Effect.runFork(Fiber.interrupt(loop));
  }

  /** Re-evaluates the next due time. Called after any commit that added a timer. */
  wake() {
    Latch.openUnsafe(this.woken);
  }

  /** How long to sleep before the next pass: until the next timer is due, at most `MAX_SLEEP_MS`. */
  private nextWait(): number {
    const next = this.app.db.get<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM timers");
    return next?.due_at == null ? MAX_SLEEP_MS : Math.min(Math.max(next.due_at - this.app.now(), 0), MAX_SLEEP_MS);
  }

  private run(): Effect.Effect<never> {
    const pass = Effect.gen({ self: this }, function* () {
      yield* Latch.close(this.woken);
      this.runDue();
      yield* Effect.sleep(this.nextWait()).pipe(Effect.raceFirst(this.woken.await));
    }).pipe(
      // A pass that throws (the database, say) is logged and retried after a pause instead of stopping every timer for good.
      Effect.catchCause((cause) => Effect.sync(() => console.error("scheduler pass failed", errorText(cause))).pipe(Effect.andThen(Effect.sleep(1_000)))),
    );
    return Effect.forever(pass);
  }

  /** Fires everything due now. Returns how many timers fired. Jobs keep running after this returns; see `idle`. */
  runDue(): number {
    const { app } = this;
    let fired = 0;
    for (;;) {
      const row = app.db.get<TimerRow>("SELECT owner, name, due_at, payload FROM timers WHERE due_at <= ? ORDER BY due_at, owner, name LIMIT 1", app.now());
      if (!row) return fired;
      fired++;
      const payload = row.payload ? JSON.parse(row.payload) : undefined;
      if (isJob(row.name)) {
        app.db.tx(() => app.db.run("DELETE FROM timers WHERE owner = ? AND name = ?", row.owner, row.name));
        this.fork(row, payload);
      } else {
        this.fire(row);
      }
    }
  }

  /** Runs a claimed job as a fiber of the job set. A job reports its own failures; anything that escapes is logged here. */
  private fork(row: TimerRow, payload: unknown) {
    const job = Effect.promise(() => runJob(this.app, row.owner, row.name, payload)).pipe(
      Effect.catchCause((cause) => Effect.sync(() => console.error(`job ${row.name} failed`, errorText(cause)))),
    );
    FiberSet.addUnsafe(this.jobs, Effect.runFork(job));
  }

  private fire(row: TimerRow) {
    const { app } = this;
    try {
      app.db.tx(() => {
        app.db.run("DELETE FROM timers WHERE owner = ? AND name = ?", row.owner, row.name);
        fireTimer(app, row.owner, row.name);
      });
    } catch (e) {
      console.error(`timer ${row.name} failed`, e instanceof Error ? e.message.slice(0, 200) : "unknown"); // claimed and dropped: a poisoned timer must not loop
    }
  }

  /** Resolves when no job is running (tests, graceful shutdown). */
  idle(): Promise<void> {
    return Effect.runPromise(FiberSet.awaitEmpty(this.jobs));
  }
}
