import type { App, SchedulerLike } from "../app";
import { hasTimer, setTimer } from "./dispatch";
import { isJob, runJob } from "./jobs";
import { fireTimer } from "./lifecycle";
import { pollable } from "../services/subscriptions";

interface TimerRow {
  owner: string;
  name: string;
  due_at: number;
  payload: string | null;
}

const MAX_SLEEP_MS = 60_000; // re-check at least this often: a wall-clock jump must not strand a timer

/**
 * Fires the durable timers table. State-machine timers run synchronously in one transaction with their claim; jobs (provider
 * calls) are claimed in a transaction and then run concurrently. A timer is claimed by deleting its row, so it fires at most once;
 * on boot everything already due fires at once.
 */
export class Scheduler implements SchedulerLike {
  private handle?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = true;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly app: App) {}

  start() {
    this.stopped = false;
    this.app.scheduler = this;
    // A restart must resume watching PRs that were subscribed before it.
    if (pollable(this.app).length && !hasTimer(this.app, "", "poll")) setTimer(this.app, "", "poll", 1_000);
    this.wake();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.handle);
  }

  /** Re-evaluates the next due time. Called after any commit that added a timer. */
  wake() {
    if (this.stopped) return;
    clearTimeout(this.handle);
    this.handle = setTimeout(() => void this.tick(), 0);
  }

  private async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      this.runDue();
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    const next = this.app.db.get<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM timers");
    const wait = next?.due_at == null ? MAX_SLEEP_MS : Math.min(Math.max(next.due_at - this.app.now(), 0), MAX_SLEEP_MS);
    this.handle = setTimeout(() => void this.tick(), wait);
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
        const p = runJob(app, row.owner, row.name, payload).finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      } else {
        try {
          app.db.tx(() => {
            app.db.run("DELETE FROM timers WHERE owner = ? AND name = ?", row.owner, row.name);
            fireTimer(app, row.owner, row.name);
          });
        } catch (e) {
          console.error(`timer ${row.name} failed`, e instanceof Error ? e.message.slice(0, 200) : "unknown"); // claimed and dropped: a poisoned timer must not loop
        }
      }
    }
  }

  /** Resolves when no job is running (tests, graceful shutdown). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}
