// A Durable Object has ONE alarm; this multiplexes named timers (sleep, github token refresh, push receipts) onto it.
export class Timers {
  constructor(private ctx: DurableObjectState) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS timers (name TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  async set(name: string, at: number) {
    this.ctx.storage.sql.exec("INSERT INTO timers (name, at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at", name, at);
    await this.arm();
  }

  async cancel(name: string) {
    this.ctx.storage.sql.exec("DELETE FROM timers WHERE name = ?", name);
    await this.arm();
  }

  has(name: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM timers WHERE name = ?", name).toArray().length > 0;
  }

  /** Removes and returns timers due at `now`; call from alarm(), then arm(). */
  takeDue(now: number): string[] {
    const due = this.ctx.storage.sql.exec("SELECT name FROM timers WHERE at <= ?", now).toArray().map((r) => r.name as string);
    this.ctx.storage.sql.exec("DELETE FROM timers WHERE at <= ?", now);
    return due;
  }

  async arm() {
    const next = this.ctx.storage.sql.exec("SELECT MIN(at) AS at FROM timers").one().at as number | null;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}
