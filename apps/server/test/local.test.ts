import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { AppFail } from "../src/app";
import { decideLocal, localAccessView, REQUEST_TTL_MS, requestLocal, revokeGrant, setLocalAccess, waitLocal } from "../src/services/local";
import { harness } from "./harness";

// Local access (docs/local-access.md): nothing runs on the owner's computer without their Allow or a grant that covers exactly that.

const status = (h: ReturnType<typeof harness>, id: string) => h.app.db.get<{ status: string }>("SELECT status FROM local_requests WHERE id = ?", id)!.status;

async function settled(h: ReturnType<typeof harness>, dorkId: string, id: string) {
  for (let i = 0; i < 200 && status(h, id) === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  return waitLocal(h.app, dorkId, id, 0);
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
  it("waits for the owner, runs only what was allowed, scrubs the server's env, and a grant covers only the same command until revoked", async () => {
    const h = harness();
    const dork = h.seed("working");
    const dir = mkdtempSync(join(tmpdir(), "dorks-local-"));
    process.env.DORKS_OWNER_TOKEN = "must-not-leak";
    const command = 'echo "hi from $PWD"; echo "token=${DORKS_OWNER_TOKEN:-none}"';

    // Asked: nothing runs, the owner sees the exact command, and a second ask waits its turn.
    const r1 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "check the folder" });
    expect(r1.status).toBe("pending");
    expect(await waitLocal(h.app, dork, r1.requestId, 0)).toMatchObject({ status: "pending" });
    expect(h.events(dork).at(-1)!.body).toMatchObject({ type: "local_request", command, cwd: dir, reason: "check the folder" });
    expect(code(() => requestLocal(h.app, dork, { kind: "run", command: "ls", reason: "x" }))).toBe("conflict");

    // Declined: the agent is told, and the answer cannot change afterwards.
    decideLocal(h.app, dork, r1.requestId, "deny", undefined);
    expect(await waitLocal(h.app, dork, r1.requestId, 0)).toMatchObject({ status: "denied" });
    expect(code(() => decideLocal(h.app, dork, r1.requestId, "once", undefined))).toBe("conflict");

    // Allowed for 15 minutes: it runs in that folder, without the server's variables.
    const r2 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "again" });
    decideLocal(h.app, dork, r2.requestId, "grant", 15);
    const out = await settled(h, dork, r2.requestId);
    expect(out).toMatchObject({ status: "done", exitCode: 0 });
    expect(out.output).toContain(`hi from ${dir}`);
    expect(out.output).toContain("token=none");

    // The grant covers the same command in the same folder, nothing else.
    const r3 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "third" });
    expect(r3.status).toBe("running");
    expect(await settled(h, dork, r3.requestId)).toMatchObject({ status: "done" });
    const other = requestLocal(h.app, dork, { kind: "run", command: command + "; true", cwd: dir, reason: "different" });
    expect(other.status).toBe("pending");
    decideLocal(h.app, dork, other.requestId, "deny", undefined);
    const elsewhere = h.seed("working");
    const otherSession = requestLocal(h.app, elsewhere, { kind: "run", command, cwd: dir, reason: "another session" });
    expect(otherSession.status).toBe("pending");
    decideLocal(h.app, elsewhere, otherSession.requestId, "deny", undefined);
    expect(localAccessView(h.app).grants).toHaveLength(1);

    // Revoked, or another session: asks again.
    revokeGrant(h.app, localAccessView(h.app).grants[0].id);
    const r4 = requestLocal(h.app, dork, { kind: "run", command, cwd: dir, reason: "after revoke" });
    expect(r4.status).toBe("pending");

    // Unanswered: it expires with its timer.
    h.clock.t += REQUEST_TTL_MS;
    await h.settle();
    expect(await waitLocal(h.app, dork, r4.requestId, 0)).toMatchObject({ status: "expired" });

    // Turned off: what is waiting is refused, and the agent cannot ask at all.
    const r5 = requestLocal(h.app, dork, { kind: "run", command: "ls", reason: "x" });
    setLocalAccess(h.app, false);
    expect(status(h, r5.requestId)).toBe("denied");
    expect(code(() => requestLocal(h.app, dork, { kind: "run", command: "ls", reason: "x" }))).toBe("forbidden");
    delete process.env.DORKS_OWNER_TOKEN;
  });

  it("stops a command at its time limit", async () => {
    const h = harness();
    const dork = h.seed("working");
    const r = requestLocal(h.app, dork, { kind: "run", command: "echo started; sleep 30", reason: "slow", timeoutSeconds: 1 });
    decideLocal(h.app, dork, r.requestId, "once", undefined);
    const out = await settled(h, dork, r.requestId);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("time limit");
    expect(out.output).toContain("started");
  });
});

describe("reading a file on the owner's computer", () => {
  it("a folder grant covers files under it, not a symlink out of it, and Dorks' own data is never read", async () => {
    const root = mkdtempSync(join(tmpdir(), "dorks-read-"));
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "secrets.json"), "{}");
    mkdirSync(join(root, "logs"));
    writeFileSync(join(root, "logs", "a.log"), "line a\n");
    writeFileSync(join(root, "logs", "b.log"), "line b\n");
    writeFileSync(join(root, "outside.txt"), "outside\n");
    symlinkSync(join(root, "outside.txt"), join(root, "logs", "link.log"));
    writeFileSync(join(root, "logs", "bin.dat"), Buffer.from([1, 0, 2]));
    const h = harness({ config: { dataDir: data } });
    const dork = h.seed("working");

    const a = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "a.log"), reason: "read the log" });
    decideLocal(h.app, dork, a.requestId, "grant", 60);
    expect(await settled(h, dork, a.requestId)).toMatchObject({ status: "done", output: "line a\n" });

    const b = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "b.log"), reason: "and the other" });
    expect(b.status).toBe("running");
    expect(await settled(h, dork, b.requestId)).toMatchObject({ status: "done", output: "line b\n" });

    const link = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "link.log"), reason: "linked" });
    expect(link.status).toBe("pending");
    decideLocal(h.app, dork, link.requestId, "deny", undefined);

    const bin = requestLocal(h.app, dork, { kind: "read", path: join(root, "logs", "bin.dat"), reason: "binary" });
    expect(await settled(h, dork, bin.requestId)).toMatchObject({ status: "failed" });

    const secrets = requestLocal(h.app, dork, { kind: "read", path: join(data, "secrets.json"), reason: "nope" });
    decideLocal(h.app, dork, secrets.requestId, "once", undefined);
    const out = await settled(h, dork, secrets.requestId);
    expect(out.status).toBe("failed");
    expect(out.output).toBeUndefined();
  });
});
