import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcError } from "../src/rpc";
import { builtCli, closeBridges, FAKE_GH, fakeBridge, runAs, tmp } from "./helpers";

const TOKEN = "ghs_fakeInstallationToken";
const PR = "https://github.com/acme/demo/pull/12";
let cli: string;
beforeAll(() => {
  cli = builtCli();
});
afterEach(closeBridges);

/** A directory holding the "real gh" (a script that reports how it was called) under the name `gh`. */
function realGhDir() {
  const dir = tmp("real-gh-");
  symlinkSync(FAKE_GH, join(dir, "gh"));
  return dir;
}

async function gh(args: string[], env: NodeJS.ProcessEnv, opts: { path?: string[]; input?: string } = {}) {
  const report = join(tmp("report-"), "gh.json");
  const r = await runAs(cli, "gh", args, { FAKE_GH_REPORT: report, ...env }, opts.path ?? [realGhDir()], opts.input);
  let seen: { argv: string[]; token: string | null; hasSocket: boolean } | null = null;
  try {
    seen = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    /* the real gh never ran */
  }
  return { ...r, seen };
}

describe("gh shim", () => {
  it("runs the real gh with the bridge's token in GH_TOKEN only: argv, stdout, stderr and exit code are untouched", async () => {
    const b = await fakeBridge();
    const r = await gh(["issue", "list", "-R", "acme/demo", "--json", "number"], { ...b.env, FAKE_GH_STDOUT: "out\nline2\n", FAKE_GH_STDERR: "warn\n", FAKE_GH_EXIT: "4" });
    expect(r.seen).toEqual({ argv: ["issue", "list", "-R", "acme/demo", "--json", "number"], token: TOKEN, hasSocket: true });
    expect(r).toMatchObject({ code: 4, stdout: "out\nline2\n", stderr: "warn\n" });
    expect(b.calls).toEqual([{ method: "token", params: { host: "github.com" } }]);
    expect(JSON.stringify(r.seen!.argv)).not.toContain(TOKEN);
  });

  it("hands stdin to gh as is", async () => {
    const b = await fakeBridge();
    const r = await gh(["issue", "create", "--body-file", "-"], { ...b.env, FAKE_GH_ECHO_STDIN: "1" }, { input: "body from the agent\n" });
    expect(r).toMatchObject({ code: 0, stdout: "stdin:body from the agent\n" });
  });

  it("replaces a stale GH_TOKEN from the environment with the current one", async () => {
    const b = await fakeBridge();
    const r = await gh(["auth", "status"], { ...b.env, GH_TOKEN: "ghs_expiredOldToken" });
    expect(r.seen!.token).toBe(TOKEN);
  });

  it("subscribes to the PR that `gh pr create` printed, as source auto, without altering its output", async () => {
    const b = await fakeBridge();
    const r = await gh(["pr", "create", "--fill"], { ...b.env, FAKE_GH_STDOUT: `${PR}\n`, FAKE_GH_STDERR: "Creating pull request for dork/x into main in acme/demo\n" });
    expect(r).toMatchObject({ code: 0, stdout: `${PR}\n`, stderr: "Creating pull request for dork/x into main in acme/demo\n" });
    expect(b.calls.map((c) => c.method)).toEqual(["token", "pr.sub"]);
    expect(b.calls[1]!.params).toEqual({ repo: "acme/demo", number: 12, source: "auto" });
  });

  it("subscribes to every PR a `gh stack submit` reports, whichever stream they are on", async () => {
    const b = await fakeBridge();
    const r = await gh(["stack", "submit", "--auto"], {
      ...b.env,
      FAKE_GH_STDOUT: "Created https://github.com/acme/demo/pull/21\n",
      FAKE_GH_STDERR: "Created https://github.com/acme/demo/pull/22\nUpdated https://github.com/acme/demo/pull/21\n",
    });
    expect(r.code).toBe(0);
    expect(b.calls.filter((c) => c.method === "pr.sub").map((c) => c.params)).toEqual([
      { repo: "acme/demo", number: 21, source: "auto" },
      { repo: "acme/demo", number: 22, source: "auto" },
    ]);
  });

  it("does not subscribe when the command failed, was only asked for help, or is not one that creates PRs", async () => {
    const b = await fakeBridge();
    expect((await gh(["pr", "create"], { ...b.env, FAKE_GH_STDOUT: `${PR}\n`, FAKE_GH_EXIT: "1" })).code).toBe(1);
    await gh(["pr", "create", "--help"], { ...b.env, FAKE_GH_STDOUT: `see ${PR}\n` });
    await gh(["pr", "view", "12"], { ...b.env, FAKE_GH_STDOUT: `${PR}\n` });
    await gh(["pr", "list"], { ...b.env, FAKE_GH_STDOUT: `${PR}\n` });
    await gh(["stack", "view"], { ...b.env, FAKE_GH_STDERR: `${PR}\n` });
    await gh(["pr", "create"], { ...b.env, FAKE_GH_STDOUT: "no url printed\n" });
    expect(b.calls.filter((c) => c.method === "pr.sub")).toEqual([]);
  });

  it("a failing subscription costs one stderr line and never changes gh's result", async () => {
    const b = await fakeBridge({
      "pr.sub": () => {
        throw new RpcError("failed", "the backend refused the request (forbidden)");
      },
    });
    const r = await gh(["stack", "submit"], { ...b.env, FAKE_GH_STDERR: "https://github.com/acme/demo/pull/21\nhttps://github.com/acme/demo/pull/22\n" });
    expect(r.code).toBe(0);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("dorks:"))).toEqual(["dorks: could not subscribe to acme/demo#21, acme/demo#22 (the backend refused the request (forbidden)); run `dorks pr sub` to retry"]);
  });

  it("with the bridge unreachable, gh still runs (without a token) and says so once", async () => {
    const env = { DORKS_SOCK: join(tmp("gone-"), "cred.sock"), FAKE_GH_STDOUT: `${PR}\n` };
    const r = await gh(["pr", "create"], env);
    expect(r.seen!.token).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${PR}\n`);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("dorks:"))).toEqual([
      "dorks: no GitHub token for gh (cannot reach the dorks bridge in this box); running it without",
      "dorks: could not subscribe to acme/demo#12 (cannot reach the dorks bridge in this box); run `dorks pr sub` to retry",
    ]);
  });

  it("outside a dork box (no DORKS_SOCK) it is a silent pass-through", async () => {
    const r = await gh(["pr", "create"], { FAKE_GH_STDOUT: `${PR}\n`, FAKE_GH_EXIT: "2" });
    expect(r).toMatchObject({ code: 2, stdout: `${PR}\n`, stderr: "" });
    expect(r.seen).toMatchObject({ token: null, hasSocket: false });
  });

  it("finds the real gh through DORKS_REAL_GH, else by skipping itself on PATH", async () => {
    const b = await fakeBridge();
    const viaEnv = await gh(["--version"], { ...b.env, DORKS_REAL_GH: FAKE_GH }, { path: [] });
    expect(viaEnv.seen).toMatchObject({ argv: ["--version"], token: TOKEN });
    // two shims ahead of the real one on PATH: both are skipped
    const other = tmp("bin2-");
    symlinkSync(cli, join(other, "gh"));
    const viaPath = await gh(["--version"], b.env, { path: [other, realGhDir()] });
    expect(viaPath.seen).toMatchObject({ argv: ["--version"], token: TOKEN });
  });

  it("says so, with exit 127, when there is no real gh", async () => {
    const b = await fakeBridge();
    const r = await runAs(cli, "gh", ["--version"], b.env);
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/^gh: the real gh is not installed/);
  });
});
