import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv, claudeArgs } from "../src/claude";
import { loadConfig } from "../src/config";
import { asIdentity } from "../src/runas";
import { Bridge } from "../src/bridge";
import { makeLogger, Redactor } from "../src/redact";
import { builtCli, FAKE_CLAUDE, FakeTransport, makeRemote, tmp, waitFor } from "./helpers";

describe("BRIDGE_SECRET_FILE", () => {
  const base = { DORK_ID: "d", BRIDGE_URL: "https://x.convex.cloud" };

  it("is read once and unlinked, so the secret never sits in the environment", () => {
    const f = join(tmp("secret-"), "bridge-secret");
    writeFileSync(f, `${"a".repeat(64)}\n`, { mode: 0o400 });
    const cfg = loadConfig({ ...base, BRIDGE_SECRET_FILE: f });
    expect(cfg.bridgeSecret).toBe("a".repeat(64));
    expect(existsSync(f)).toBe(false);
  });

  it("falls back to BRIDGE_SECRET when there is no file, or the file was already consumed", () => {
    expect(loadConfig({ ...base, BRIDGE_SECRET: "env-secret" }).bridgeSecret).toBe("env-secret");
    expect(loadConfig({ ...base, BRIDGE_SECRET_FILE: "/nonexistent/secret", BRIDGE_SECRET: "env-secret" }).bridgeSecret).toBe("env-secret");
  });

  it("is required one way or the other", () => {
    expect(() => loadConfig(base)).toThrow(/BRIDGE_SECRET/);
  });

  it("neither the file path variable nor CLAUDE_RUN_AS reaches the child", () => {
    const env = childEnv({ PATH: "/bin", BRIDGE_SECRET_FILE: "/x", CLAUDE_RUN_AS: "dork" }, {});
    expect(Object.keys(env)).not.toContain("BRIDGE_SECRET_FILE");
    expect(Object.keys(env)).not.toContain("CLAUDE_RUN_AS");
  });
});

describe("privilege separation argv", () => {
  it("wraps with setpriv (uid, gid, supplementary groups) only when an identity is set", () => {
    expect(asIdentity(null, "claude", ["-p"])).toEqual(["claude", ["-p"]]);
    const [bin, args] = asIdentity({ user: "dork", uid: 1001, gid: 1002, home: "/home/dork" }, "claude", claudeArgs({ permissionMode: "bypassPermissions", resumeSessionId: null }));
    expect(bin).toBe("setpriv");
    expect(args.slice(0, 4)).toEqual(["--reuid=1001", "--regid=1002", "--init-groups", "--"]);
    expect(args[4]).toBe("claude");
  });

  it("the child gets the run-as user's HOME, not the bridge's", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/root" }, { HOME: "/evil" }, undefined, { user: "dork", uid: 1, gid: 1, home: "/home/dork" });
    expect(env.HOME).toBe("/home/dork");
    expect(env.USER).toBe("dork");
  });
});

// Real uid separation needs root. Run it with:  sudo -E env PATH=$PATH npx vitest run test/privsep.test.ts
describe.skipIf(typeof process.getuid !== "function" || process.getuid() !== 0)("CLAUDE_RUN_AS=nobody (root only)", () => {
  it("claude and its git tree run as the unprivileged user; it cannot read the bridge's environ or secret", async () => {
    const root = tmp("privsep-");
    chmodSync(root, 0o755);
    const cli = builtCli();
    // the unprivileged user must be able to execute the fake CLI and traverse to it
    const fake = join(root, "fake-claude.mjs");
    copyFileSync(FAKE_CLAUDE, fake);
    chmodSync(fake, 0o755);
    const remote = makeRemote();
    chmodSync(remote.baseUrl.replace("file://", ""), 0o755);
    execFileSync("chmod", ["-R", "a+rX", remote.baseUrl.replace("file://", "")]);
    const state = join(root, "state");
    const work = join(root, "work");
    const report = join(root, "report", "child.json");
    mkdirSync(join(root, "report"), { mode: 0o777 });
    chmodSync(join(root, "report"), 0o777);
    const secretFile = join(root, "secret");
    writeFileSync(secretFile, "s".repeat(64), { mode: 0o400 });
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", DORK_ID: "d1", BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET_FILE: secretFile,
      DORKS_STATE_DIR: state, DORKS_WORKDIR: work, DORKS_GIT_BASE_URL: remote.baseUrl, CLAUDE_BIN: fake, CLAUDE_RUN_AS: "nobody", DORKS_BATCH_MS: "5",
    };
    const cfg = loadConfig(hostEnv);
    expect(existsSync(secretFile)).toBe(false);
    const t = new FakeTransport();
    t.configureFrame = { t: "configure", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-privsep", FAKE_CLAUDE_REPORT: report, FAKE_CLAUDE_DELTAS: "2" }, ghToken: "ghs_privsep_token", repo: { fullName: "acme/demo", branch: "dork/p" }, resumeSessionId: null };
    const redactor = new Redactor();
    const logs: string[] = [];
    const b = new Bridge({ cfg, transport: t, log: makeLogger("p", redactor, (l) => logs.push(l)), redactor, baseEnv: hostEnv, selfCommand: [process.execPath, cli] });
    await b.start();
    try {
      t.emit([{ cid: "c", frame: { t: "fetch_configure" } }]);
      await waitFor(() => t.of("ready").length, `ready (frames: ${JSON.stringify(t.frames)} logs: ${logs.join(" | ")})`, 20_000).catch((e) => {
        throw new Error(`${e.message} :: frames ${JSON.stringify(t.frames)} logs ${logs.join(" | ")}`);
      });
      await waitFor(() => existsSync(report) && readFileSync(report, "utf8").endsWith("}"), "report");
      const rep = JSON.parse(readFileSync(report, "utf8"));
      const uid = Number(execFileSync("id", ["-u", "nobody"]).toString());
      expect(statSync(`/proc/${rep.pid}`).uid).toBe(uid); // claude runs as nobody
      expect(rep.env.HOME).not.toBe("/root");
      expect(statSync(join(work, "acme/demo/.git")).uid).toBe(uid); // its working tree is theirs
      // the Claude user cannot read the bridge's environment or memory
      const environ = `/proc/${process.pid}/environ`;
      expect(() => execFileSync("setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "cat", environ], { stdio: "pipe" })).toThrow();
      expect(() => execFileSync("setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "cat", join(state, "messages.log")], { stdio: "pipe" })).toThrow();
      // ...but it can use the credential helper (that is how its git push authenticates)
      const sock = join(state, "cred/cred.sock");
      expect(statSync(sock).uid).toBe(uid);
    } finally {
      await b.stop(500);
    }
  }, 60_000);
});
