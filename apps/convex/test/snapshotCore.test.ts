// core/snapshot.ts: limits, the rule for which snapshot a new box boots from, log redaction, and the shell scripts that run inside the
// build box (executed here with a real bash, the same way upstash.test.ts exercises execStartScript).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_REPOS, bashCommand, BUILD_DIR, clampTimeoutMinutes, cleanupScript, DEFAULT_BUILD_TIMEOUT_MIN, LOG_TAIL_CHARS, MAX_BUILD_TIMEOUT_MIN, MAX_SETUP_SCRIPT_BYTES, MIN_BUILD_TIMEOUT_MIN,
  outdatedReason, parsePoll, pickSnapshot, redactLog, runnerScript, scriptHash, validateSetupScript, verifyScript,
} from "../core/snapshot";

describe("validateSetupScript", () => {
  it("accepts a normal script and refuses empty, oversize and NUL", () => {
    expect(validateSetupScript("npm ci\n")).toBeNull();
    expect(validateSetupScript("   \n\t")).toMatch(/empty/);
    expect(validateSetupScript("x".repeat(MAX_SETUP_SCRIPT_BYTES))).toBeNull();
    expect(validateSetupScript("x".repeat(MAX_SETUP_SCRIPT_BYTES + 1))).toMatch(/larger/);
    expect(validateSetupScript("é".repeat(MAX_SETUP_SCRIPT_BYTES / 2 + 1))).toMatch(/larger/); // bytes, not characters
    expect(validateSetupScript("a\0b")).toMatch(/NUL/);
  });
});

describe("clampTimeoutMinutes", () => {
  it("defaults, rounds and clamps", () => {
    expect(clampTimeoutMinutes(undefined)).toBe(DEFAULT_BUILD_TIMEOUT_MIN);
    expect(clampTimeoutMinutes(NaN)).toBe(DEFAULT_BUILD_TIMEOUT_MIN);
    expect(clampTimeoutMinutes(Infinity)).toBe(DEFAULT_BUILD_TIMEOUT_MIN);
    expect(clampTimeoutMinutes(0)).toBe(MIN_BUILD_TIMEOUT_MIN);
    expect(clampTimeoutMinutes(1e6)).toBe(MAX_BUILD_TIMEOUT_MIN);
    expect(clampTimeoutMinutes(7.4)).toBe(7);
  });
});

describe("scriptHash", () => {
  it("is stable, changes with the text and ignores CRLF", async () => {
    expect(await scriptHash("a\nb")).toBe(await scriptHash("a\r\nb"));
    expect(await scriptHash("a")).not.toBe(await scriptHash("b"));
    expect(await scriptHash("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pickSnapshot: which snapshot a new box boots from", () => {
  const base = { accountSnapshotId: "acct", baseSnapshotId: "base" };
  it("exact repo image, then the all-repos image, then the account override, then the base", () => {
    const images = [{ repo: ALL_REPOS, snapshotId: "all" }, { repo: "o/r", snapshotId: "repo" }];
    expect(pickSnapshot({ repo: "o/r", images, ...base })).toEqual({ snapshotId: "repo", source: "repo" });
    expect(pickSnapshot({ repo: "o/other", images, ...base })).toEqual({ snapshotId: "all", source: "default" });
    expect(pickSnapshot({ repo: "o/other", images: [], ...base })).toEqual({ snapshotId: "acct", source: "account" });
    expect(pickSnapshot({ repo: "o/other", images: [], baseSnapshotId: "base" })).toEqual({ snapshotId: "base", source: "base" });
    expect(pickSnapshot({ repo: "o/other", images: [] })).toBeNull();
  });
  it("matches the repo case-insensitively (images are stored lowercase)", () => {
    expect(pickSnapshot({ repo: "Octocat/Hello-World", images: [{ repo: "octocat/hello-world", snapshotId: "s" }], ...base })?.source).toBe("repo");
  });
  it("skips images with no ready snapshot, so a first build in progress or a failed one never blocks a new dork", () => {
    expect(pickSnapshot({ repo: "o/r", images: [{ repo: "o/r" }, { repo: ALL_REPOS, snapshotId: null }], ...base })).toEqual({ snapshotId: "acct", source: "account" });
  });
});

describe("outdatedReason", () => {
  it("flags a changed script or base snapshot and nothing else", () => {
    const ok = { builtScriptHash: "h", builtBaseSnapshotId: "b", scriptHash: "h", currentBaseSnapshotId: "b" };
    expect(outdatedReason(ok)).toBeNull();
    expect(outdatedReason({ ...ok, scriptHash: "h2" })).toBe("script_changed");
    expect(outdatedReason({ ...ok, currentBaseSnapshotId: "b2" })).toBe("base_changed");
    expect(outdatedReason({ ...ok, currentBaseSnapshotId: null })).toBeNull(); // no base configured now: nothing to compare with
  });
});

describe("redactLog", () => {
  it("removes tokens, credentials in URLs and key blocks, and keeps only the tail", () => {
    const out = redactLog(
      [
        `clone https://x-access-token:ghs_${"a".repeat(36)}@github.com/o/r`,
        `export T=ghp_${"b".repeat(36)} U=github_pat_${"c".repeat(30)} K=sk-ant-oat01-${"d".repeat(30)}`,
        "Authorization: Bearer abc.def.ghi",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
        "fine line",
      ].join("\n"),
    );
    expect(out).not.toMatch(/ghs_a|ghp_b|github_pat_c|sk-ant-oat01-d|abc\.def|AAAA/);
    expect(out).toContain("fine line");
    expect(redactLog("x".repeat(LOG_TAIL_CHARS * 2))).toHaveLength(LOG_TAIL_CHARS);
  });
});

describe("parsePoll", () => {
  it("reads the state line and redacts the log", () => {
    expect(parsePoll("STATE:running\nbuilding\n")).toEqual({ state: "running", log: "building\n" });
    expect(parsePoll("STATE:done:0\nok")).toEqual({ state: "done", exitCode: 0, log: "ok" });
    expect(parsePoll("STATE:done:3\n")).toEqual({ state: "done", exitCode: 3, log: "" });
    expect(parsePoll("STATE:lost\nx").state).toBe("lost");
    expect(parsePoll("garbage").state).toBe("lost");
    expect(parsePoll(`STATE:running\ntoken ghs_${"z".repeat(30)}`)).toMatchObject({ log: "token [redacted]" });
  });
});

// ---------------------------------------------------------------- the scripts, run with a real bash
const bash = (script: string, env: Record<string, string>, cwd?: string) => spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, ...env }, cwd, encoding: "utf8" });
const linux = process.platform === "linux";
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!linux)("runner script (real bash)", () => {
  const run = (setup: string) => {
    const home = mkdtempSync(join(tmpdir(), "snapimg-"));
    rmSync(BUILD_DIR, { recursive: true, force: true });
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(`${BUILD_DIR}/setup.sh`, setup);
    writeFileSync(`${BUILD_DIR}/run.sh`, runnerScript(ALL_REPOS));
    const r = bash(`bash ${BUILD_DIR}/run.sh`, { HOME: home });
    const exit = existsSync(`${BUILD_DIR}/exit`) ? readFileSync(`${BUILD_DIR}/exit`, "utf8").trim() : null;
    const out = { exit, stdout: r.stdout, home, tools: existsSync(`${BUILD_DIR}/tools.before`) ? readFileSync(`${BUILD_DIR}/tools.before`, "utf8") : "" };
    return out;
  };
  it("runs the script in ~/work, writes the exit code last, and records where the toolchain resolves", () => {
    const r = run("pwd > $HOME/where.txt\nexport -p | grep -E 'DORKS_BUILD|DORKS_REPO' >> $HOME/where.txt\n");
    expect(r.exit).toBe("0");
    expect(readFileSync(join(r.home, "where.txt"), "utf8")).toContain(`${r.home}/work`);
    expect(readFileSync(join(r.home, "where.txt"), "utf8")).toMatch(/DORKS_BUILD="1"/);
    expect(r.tools).toMatch(/^node=.+node$/m);
    expect(r.tools.split("\n").filter(Boolean)).toHaveLength(6);
    rmSync(r.home, { recursive: true, force: true });
  });
  it("reports the script's exit code, and `set -e` applies to it", () => {
    expect(run("exit 3\n").exit).toBe("3");
    expect(run("false\necho not reached > $HOME/after.txt\n").exit).toBe("1");
    const r = run("false | true\ntrue\n"); // pipefail: a failed pipeline stage fails the script
    expect(r.exit).toBe("1");
  });
  it("the customer's script cannot see a clone token: it is deleted before the script runs", () => {
    const home = mkdtempSync(join(tmpdir(), "snapimg-"));
    rmSync(BUILD_DIR, { recursive: true, force: true });
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(`${BUILD_DIR}/setup.sh`, `ls ${BUILD_DIR} > $HOME/files.txt\n`);
    writeFileSync(`${BUILD_DIR}/gh-token`, "ghs_secret");
    // a clone of a non-existent URL fails, which must still delete the token and report the clone failure
    writeFileSync(`${BUILD_DIR}/run.sh`, runnerScript("no-such-owner-zzz/no-such-repo-zzz"));
    const r = bash(`GIT_CONFIG_GLOBAL=/dev/null bash ${BUILD_DIR}/run.sh`, { HOME: home });
    expect(existsSync(`${BUILD_DIR}/gh-token`)).toBe(false);
    expect(readFileSync(`${BUILD_DIR}/exit`, "utf8").trim()).not.toBe("0");
    expect(r.stdout).toMatch(/git clone failed/);
    rmSync(home, { recursive: true, force: true });
  });
  it("the repo name is quoted: a hostile name cannot run commands", () => {
    const home = mkdtempSync(join(tmpdir(), "snapimg-"));
    const marker = join(home, "pwned");
    rmSync(BUILD_DIR, { recursive: true, force: true });
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(`${BUILD_DIR}/setup.sh`, "true\n");
    writeFileSync(`${BUILD_DIR}/run.sh`, runnerScript(`a/b'; touch ${marker}; echo '`));
    bash(`GIT_CONFIG_GLOBAL=/dev/null bash ${BUILD_DIR}/run.sh`, { HOME: home });
    expect(existsSync(marker)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe.skipIf(!linux)("verify and cleanup scripts (real bash)", () => {
  const withHome = (fn: (home: string, bin: string) => void) => {
    const home = mkdtempSync(join(tmpdir(), "snapverify-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    rmSync(BUILD_DIR, { recursive: true, force: true });
    mkdirSync(BUILD_DIR, { recursive: true });
    try {
      fn(home, bin);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(BUILD_DIR, { recursive: true, force: true });
    }
  };
  const tool = (bin: string, name: string) => {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  };
  const verify = (home: string, bin: string) => bash(bashCommand(verifyScript), { HOME: home, PATH: `${bin}:/usr/bin:/bin` });

  it("passes when every tool still resolves where it did, and fails naming the tool when it moved or vanished", () => {
    withHome((home, bin) => {
      tool(bin, "node");
      writeFileSync(`${BUILD_DIR}/tools.before`, `node=${bin}/node\ngit=\nclaude=\ndorks-bridge=\ndorks=\ngh=\n`);
      expect(verify(home, bin).status).toBe(0);
      rmSync(join(bin, "node"));
      const r = verify(home, bin);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/tool changed: node was .*, now (missing|\S*node)/);
    });
  });
  it("refuses a credential in the home directory but not in the cloned repo, and never prints the credential", () => {
    withHome((home, bin) => {
      writeFileSync(`${BUILD_DIR}/tools.before`, "");
      mkdirSync(join(home, "work/o/r"), { recursive: true });
      writeFileSync(join(home, "work/o/r/docs.md"), `example: ghp_${"x".repeat(36)}\n`); // documentation in the repo is not a leak
      expect(verify(home, bin).status).toBe(0);
      writeFileSync(join(home, ".npmrc"), `//registry/:_authToken=ghp_${"y".repeat(36)}\n`);
      const r = verify(home, bin);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(".npmrc");
      expect(r.stdout).not.toContain("yyyy");
    });
  });
  it("tolerates the two files the platform writes into every box, and flags credentials in a git remote", () => {
    withHome((home, bin) => {
      writeFileSync(`${BUILD_DIR}/tools.before`, "");
      writeFileSync(join(home, ".git-credentials"), `https://x-access-token:ghs_${"z".repeat(36)}@github.com\n`);
      mkdirSync(join(home, ".config/gh"), { recursive: true });
      writeFileSync(join(home, ".config/gh/hosts.yml"), `github.com:\n    oauth_token: ghs_${"z".repeat(36)}\n`);
      expect(verify(home, bin).status).toBe(0);
      mkdirSync(join(home, "work/o/r/.git"), { recursive: true });
      writeFileSync(join(home, "work/o/r/.git/config"), "[remote \"origin\"]\n\turl = https://user:pw@github.com/o/r.git\n");
      const r = verify(home, bin);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/git remote with credentials/);
    });
  });
  it("cleanup removes the build directory and the platform-written credentials", () => {
    withHome((home) => {
      writeFileSync(join(home, ".git-credentials"), "x");
      mkdirSync(join(home, ".dorks-bridge"));
      mkdirSync(join(home, ".config/gh"), { recursive: true });
      writeFileSync(join(home, ".config/gh/hosts.yml"), "x");
      writeFileSync(join(home, "keep.txt"), "x");
      expect(bash(bashCommand(cleanupScript), { HOME: home }).status).toBe(0);
      expect(existsSync(join(home, ".git-credentials"))).toBe(false);
      expect(existsSync(join(home, ".config/gh/hosts.yml"))).toBe(false);
      expect(existsSync(join(home, ".dorks-bridge"))).toBe(false);
      expect(existsSync(BUILD_DIR)).toBe(false);
      expect(existsSync(join(home, "keep.txt"))).toBe(true);
    });
  });
  it("bashCommand quotes the script for sh -c", () => {
    expect(bash(`sh -c ${sh(bashCommand("echo 'it works'"))}`, {}).stdout.trim()).toBe("it works");
  });
});
