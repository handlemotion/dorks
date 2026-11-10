import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db, insert } from "../src/db";
import { setTimer } from "../src/lifecycle/dispatch";
import { INBOX_RETENTION_MS, SWEEP_EVERY_MS } from "../src/lifecycle/jobs";
import { Scheduler } from "../src/lifecycle/scheduler";
import { createApp } from "../src/server";
import { subscribe } from "../src/services/subscriptions";
import { harness, NOW, testConfig } from "./harness";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("durable timers", () => {
  it("a timer set before a restart fires after it, once, and a restart does not re-run what already fired", () => {
    const dir = mkdtempSync(join(tmpdir(), "dorks-sched-"));
    dirs.push(dir);
    const path = join(dir, "dorks.db");
    let now = NOW;
    const first = createApp(testConfig(), { db: new Db(path), now: () => now });
    const id = "d1";
    const seed = (app: typeof first) => {
      insert(app.db, "dorks", { id, title: "t", repo: "o/r", branch: "b", provider: "claude", state: "idle", archived: false, boxId: "box-1", deleting: false, lastActivityAt: 1, createdAt: 1 });
      insert(app.db, "dork_runtime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: NOW + 6 * 60_000 - 1000, bridgeLost: false, opGen: 0, pauseRetries: 0 }); // a bridge that was alive just before the sleep timer is due
    };
    seed(first);
    setTimer(first, id, "sleep", 5 * 60_000);
    first.db.close();

    now = NOW + 6 * 60_000; // the app was closed for six minutes
    const second = createApp(testConfig(), { db: new Db(path), now: () => now });
    const scheduler = new Scheduler(second);
    expect(scheduler.runDue()).toBe(1); // the sleep timer fires on boot
    expect(second.db.get("SELECT COUNT(*) AS n FROM commands WHERE kind = 'flush'")?.n).toBe(1); // sleep_due -> flush the bridge first
    expect(scheduler.runDue()).toBe(0);
    second.db.close();
  });
});

describe("recovery on start", () => {
  it("resumes watching PRs subscribed before the restart", () => {
    const h = harness();
    const id = h.seed("idle");
    h.app.db.tx(() => subscribe(h.app, h.dork(id), "o/r", 1, "agent"));
    h.app.db.run("DELETE FROM timers WHERE name = 'poll'");
    new Scheduler(h.app).recover();
    expect(h.hasTimer("", "poll")).toBe(true);
  });

  it("finishes a delete the crash interrupted", async () => {
    const h = harness();
    const id = h.seed("idle");
    h.app.db.run("UPDATE dorks SET deleting = 1 WHERE id = ?", id);
    new Scheduler(h.app).recover();
    await h.settle();
    expect(h.box.calls).toEqual(["delete"]);
    expect(h.app.db.get("SELECT COUNT(*) AS n FROM dorks")?.n).toBe(0);
  });

  it("does not queue a second delete when one is already pending", () => {
    const h = harness();
    const id = h.seed("idle");
    h.app.db.run("UPDATE dorks SET deleting = 1 WHERE id = ?", id);
    setTimer(h.app, id, "box:destroy", 0);
    new Scheduler(h.app).recover();
    expect(h.app.db.all("SELECT 1 FROM timers WHERE owner = ? AND name = 'box:destroy'", id)).toHaveLength(1);
  });
});

describe("retention sweep", () => {
  it("prunes delivered inbox rows older than a day, nothing else, and comes back", async () => {
    const h = harness();
    const id = h.seed("idle");
    h.app.db.tx(() => subscribe(h.app, h.dork(id), "o/r", 1, "agent"));
    const subId = h.app.db.get<{ id: number }>("SELECT id FROM pr_subscriptions")!.id;
    const row = (createdAt: number, delivered: number) => h.app.db.run("INSERT INTO inbox (dork_id, subscription_id, kind, summary, created_at, delivered) VALUES (?, ?, 'comment', 's', ?, ?)", id, subId, createdAt, delivered);
    row(NOW - 2 * INBOX_RETENTION_MS, 1); // old and delivered: pruned
    row(NOW - 2 * INBOX_RETENTION_MS, 0); // old but still waiting for the agent: kept
    row(NOW - 1000, 1); // recent: kept
    new Scheduler(h.app).recover();
    await h.advance(60_000);
    expect(h.app.db.all("SELECT delivered FROM inbox ORDER BY id").map((r) => r.delivered)).toEqual([0, 1]);
    expect(h.app.db.get("SELECT due_at FROM timers WHERE owner = '' AND name = 'sweep'")?.due_at).toBe(NOW + 60_000 + SWEEP_EVERY_MS);
  });
});
