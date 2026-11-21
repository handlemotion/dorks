import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { AppFail } from "../src/app";
import { decideLocal, localAccessView, REQUEST_TTL_MS, requestLocal, revokeSessions, setLocalAccess, waitLocal } from "../src/services/local";
import { readSettings, updateSettings } from "../src/services/settings";
import { harness } from "./harness";

// Local access (docs/local-access.md): nothing runs on the owner's computer unless they allowed this session, or every session.

const status = (h: ReturnType<typeof harness>, id: string) => h.app.db.get<{ status: string }>("SELECT status FROM local_requests WHERE id = ?", id)!.status;

async function settled(h: ReturnType<typeof harness>, dorkId: string, id: string) {
  for (let i = 0; i < 200 && status(h, id) === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  return waitLocal(h.app, dorkId, id, 0);
}

/** Running, not merely an unreaped zombie (a container's init may never reap it). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
  } catch {
    return true; // no /proc (macOS): kill(0) answered, so it runs
  }
}

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof AppFail ? e.error.code : "thrown";
  }
  return "ok";
};

describe("running a command on the owner's computer", () => {
  it("asks once per session, scrubs the server's env, and Always allow, its setting and the off switch decide who asks again", async () => {
    const h = harness();
    const dork = h.seed("working");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dorks-local-"))); // macOS: /var is /private/var, and `pwd` prints the latter
    process.env.DORKS_OWNER_TOKEN = "must-not-leak";
    const command = 'echo "hi from $PWD"; echo "token=${DORKS_OWNER_TOKEN:-none}"';

    // Asked: nothing runs, the owner sees the exact command, and a second ask waits its turn.
    const r1 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "check the folder" });
    expect(r1.status).toBe("pending");
    expect(await waitLocal(h.app, dork, r1.requestId, 0)).toMatchObject({ status: "pending" });
    expect(h.events(dork).at(-1)!.body).toMatchObject({ type: "local_request", command, cwd: dir, reason: "check the folder" });
    expect(code(() => requestLocal(h.app, dork, { kind: "run", command: "ls", reason: "x" }))).toBe("conflict");

    // Declined: the agent is told, the answer cannot change afterwards, and the next request asks again.
    decideLocal(h.app, dork, r1.requestId, "deny");
    expect(await waitLocal(h.app, dork, r1.requestId, 0)).toMatchObject({ status: "denied" });
    expect(code(() => decideLocal(h.app, dork, r1.requestId, "session"))).toBe("conflict");

    // Allowed for this session: it runs in that folder, without the server's variables.
    const r2 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "again" });
    expect(r2.status).toBe("pending");
    decideLocal(h.app, dork, r2.requestId, "session");
    const out = await settled(h, dork, r2.requestId);
    expect(out).toMatchObject({ status: "done", exitCode: 0 });
    expect(out.output).toContain(`hi from ${dir}`);
    expect(out.output).toContain("token=none");

    // Every later request of this session runs without asking; another session still asks.
    const r3 = requestLocal(h.app, dork, { kind: "run", command: "echo third", cwd: dir, reason: "third" });
    expect(r3.status).toBe("running");
    expect(await settled(h, dork, r3.requestId)).toMatchObject({ status: "done" });
    const elsewhere = h.seed("working");
    const waiting = requestLocal(h.app, elsewhere, { kind: "run", command: "echo other", cwd: dir, reason: "another session" });
    expect(waiting.status).toBe("pending");
    expect(localAccessView(h.app).sessions.map((s) => s.dorkId)).toEqual([dork]);

    // Always allow from a third session: turns the setting on, and the session already waiting runs too.
    const third = h.seed("working");
    const r4 = requestLocal(h.app, third, { kind: "run", command: "echo always", cwd: dir, reason: "always" });
    decideLocal(h.app, third, r4.requestId, "always");
    expect(readSettings(h.app).localAlwaysAllow).toBe(true);
    expect(await settled(h, elsewhere, waiting.requestId)).toMatchObject({ status: "done" });
    expect(requestLocal(h.app, h.seed("working"), { kind: "run", command: "true", cwd: dir, reason: "new" }).status).toBe("running");

    // Always allow off again (Settings): new sessions ask; the session allowed earlier keeps its permission until it is stopped.
    await updateSettings(h.app, { localAlwaysAllow: false });
    const r5 = requestLocal(h.app, elsewhere, { kind: "run", command: "true", cwd: dir, reason: "asks again" });
    expect(r5.status).toBe("pending");
    expect(requestLocal(h.app, dork, { kind: "run", command: "true", cwd: dir, reason: "still allowed" }).status).toBe("running");
    revokeSessions(h.app, dork);
    const r7 = requestLocal(h.app, dork, { kind: "run", command: "true", cwd: dir, reason: "after stop" });
    expect(r7.status).toBe("pending");

    // Unanswered: it expires with its timer.
    h.clock.t += REQUEST_TTL_MS;
    await h.settle();
    expect(await waitLocal(h.app, elsewhere, r5.requestId, 0)).toMatchObject({ status: "expired" });
    const r8 = requestLocal(h.app, elsewhere, { kind: "run", command: "true", cwd: dir, reason: "waiting" });

    // Always allow turned on in Settings answers what is waiting, as the prompt's Always allow does.
    await updateSettings(h.app, { localAlwaysAllow: true });
    expect(await settled(h, elsewhere, r8.requestId)).toMatchObject({ status: "done" });

    // Turned off: Always allow and every permission end, and the agent cannot ask at all.
    setLocalAccess(h.app, false);
    expect(readSettings(h.app).localAlwaysAllow).toBe(false);
    expect(localAccessView(h.app).sessions).toEqual([]);
    expect(code(() => requestLocal(h.app, dork, { kind: "run", command: "ls", reason: "x" }))).toBe("forbidden");
    // ...and what is waiting when it is turned off is refused.
    setLocalAccess(h.app, true);
    const r9 = requestLocal(h.app, elsewhere, { kind: "run", command: "true", cwd: dir, reason: "waiting when turned off" });
    setLocalAccess(h.app, false);
    expect(status(h, r9.requestId)).toBe("denied");
    delete process.env.DORKS_OWNER_TOKEN;
  });

  it("stops a command at its time limit", async () => {
    const h = harness();
    const dork = h.seed("working");
    const r = requestLocal(h.app, dork, { kind: "run", command: "echo started; sleep 30", reason: "slow", timeoutSeconds: 1 });
    decideLocal(h.app, dork, r.requestId, "session");
    const out = await settled(h, dork, r.requestId);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("time limit");
    expect(out.output).toContain("started");
  });

  it("ends what a command left running in the background once it returns", async () => {
    const h = harness();
    const dork = h.seed("working");
    const r = requestLocal(h.app, dork, { kind: "run", command: "sleep 30 >/dev/null 2>&1 & echo $!", reason: "background" });
    decideLocal(h.app, dork, r.requestId, "session");
    const out = await settled(h, dork, r.requestId);
    expect(out.status).toBe("done");
    const pid = Number(out.output!.trim());
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });
});

describe("reading a file on the owner's computer", () => {
  it("reads text files once the session is allowed, never a binary, and never Dorks' own data, not even through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "dorks-read-"));
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "secrets.json"), "{}");
    mkdirSync(join(root, "logs"));
    writeFileSync(join(root, "logs", "a.log"), "line a\n");
    symlinkSync(join(data, "secrets.json"), join(root, "logs", "link.log"));
    writeFileSync(join(root, "logs", "bin.dat"), Buffer.from([1, 0, 2]));
    const h = harness({ config: { dataDir: data } });
    const dork = h.seed("working");

    const a = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "a.log"), reason: "read the log" });
    decideLocal(h.app, dork, a.requestId, "session");
    expect(await settled(h, dork, a.requestId)).toMatchObject({ status: "done", output: "line a\n" });

    const bin = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "bin.dat"), reason: "binary" });
    expect(await settled(h, dork, bin.requestId)).toMatchObject({ status: "failed" });

    for (const path of [join(data, "secrets.json"), join(root, "logs", "link.log")]) {
      const r = requestLocal(h.app, dork, { kind: "read", path, reason: "nope" });
      expect(r.status).toBe("running");
      const out = await settled(h, dork, r.requestId);
      expect(out.status).toBe("failed");
      expect(out.output).toBeUndefined();
    }
  });
});
