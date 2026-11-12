import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { RpcError } from "../src/rpc";
import { builtCli, closeBridges, fakeBridge, fakeView, runAs, tmp } from "./helpers";

let cli: string;
beforeAll(() => {
  cli = builtCli();
});

afterEach(closeBridges);

const dorks = (args: string[], env: NodeJS.ProcessEnv) => runAs(cli, "dorks", args, env);

describe("dorks pr", () => {
  it("sub accepts a PR URL or owner/name#n and subscribes as the agent", async () => {
    const b = await fakeBridge();
    const a = await dorks(["pr", "sub", "https://github.com/acme/demo/pull/12"], b.env);
    expect(a).toMatchObject({ code: 0, stdout: "Subscribed to acme/demo#12\n", stderr: "" });
    expect((await dorks(["pr", "sub", "acme/other#3"], b.env)).stdout).toBe("Subscribed to acme/other#3\n");
    expect(b.calls).toEqual([
      { method: "pr.sub", params: { repo: "acme/demo", number: 12, source: "agent" } },
      { method: "pr.sub", params: { repo: "acme/other", number: 3, source: "agent" } },
    ]);
  });

  it("unsub", async () => {
    const b = await fakeBridge();
    expect(await dorks(["pr", "unsub", "acme/demo#12"], b.env)).toMatchObject({ code: 0, stdout: "Unsubscribed from acme/demo#12\n" });
    expect(b.calls).toEqual([{ method: "pr.unsub", params: { repo: "acme/demo", number: 12 } }]);
  });

  it("list prints one readable entry per PR; says so when there are none; --json is machine readable", async () => {
    const empty = await fakeBridge();
    expect((await dorks(["pr", "list"], empty.env)).stdout).toBe("No PR subscriptions.\n");
    expect(JSON.parse((await dorks(["pr", "list", "--json"], empty.env)).stdout)).toEqual([]);

    const subs = [
      { ...fakeView({ repo: "acme/demo", number: 12 }), title: "Fix login", ci: "failing", review: "changes_requested", mergeable: false, ciFixAttempts: 1 },
      { ...fakeView({ repo: "acme/other", number: 3 }), ci: "passing", review: "approved", mergeable: true, status: "stalled" },
      fakeView({ repo: "acme/demo", number: 4 }),
    ];
    const b = await fakeBridge({ "pr.list": () => subs });
    const human = await dorks(["pr", "list"], b.env);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(
      [
        "acme/demo#12  open  ci failing, review changes_requested, has conflicts, ci fix attempts 1  Fix login",
        "  https://github.com/acme/demo/pull/12",
        "acme/other#3  open  ci passing, review approved, mergeable, STALLED (needs a human)",
        "  https://github.com/acme/other/pull/3",
        "acme/demo#4  open  ci unknown, review none, mergeability unknown",
        "  https://github.com/acme/demo/pull/4",
        "",
      ].join("\n"),
    );
    expect(JSON.parse((await dorks(["pr", "list", "--json"], b.env)).stdout)).toEqual(subs);
  });

  it("rejects bad references and arguments with exit 2, without calling the bridge", async () => {
    const b = await fakeBridge();
    for (const args of [
      ["pr", "sub"],
      ["pr", "sub", "12"],
      ["pr", "sub", "acme/demo"],
      ["pr", "unsub", "https://example.com/a/b/pull/1"],
      ["pr", "sub", "acme/demo#1", "acme/demo#2"],
      ["pr", "list", "extra"],
      ["pr", "merge"],
      ["repo", "list"],
    ]) {
      const r = await dorks(args, b.env);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toMatch(/^dorks: /);
    }
    expect(b.calls).toEqual([]);
  });

  it("prints usage: exit 0 for --help, 2 for no arguments", async () => {
    const b = await fakeBridge();
    const help = await dorks(["--help"], b.env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("dorks pr sub <pr>");
    expect((await dorks([], b.env)).code).toBe(2);
  });

  it("exits 1 with a clear message when the bridge is unreachable or this is not a dork box", async () => {
    const gone = await dorks(["pr", "list"], { DORKS_SOCK: join(tmp("gone-"), "cred.sock") });
    expect(gone).toMatchObject({ code: 1, stdout: "", stderr: "dorks: cannot reach the dorks bridge in this box\n" });
    expect(await dorks(["pr", "sub", "acme/demo#1"], {})).toMatchObject({ code: 1, stderr: "dorks: DORKS_SOCK is not set; this only works inside a dork box\n" });
  });

  it("shows the bridge's explanation when it refuses", async () => {
    const b = await fakeBridge({
      "pr.sub": () => {
        throw new RpcError("failed", "the backend refused the request (not_found)");
      },
    });
    expect(await dorks(["pr", "sub", "acme/demo#1"], b.env)).toMatchObject({ code: 1, stderr: "dorks: the backend refused the request (not_found)\n" });
  });

  it("also runs as a subcommand of the bridge binary", async () => {
    const b = await fakeBridge();
    const r = await runAs(cli, "dorks-bridge", ["dorks", "pr", "sub", "acme/demo#7"], b.env);
    expect(r).toMatchObject({ code: 0, stdout: "Subscribed to acme/demo#7\n" });
  });
});
