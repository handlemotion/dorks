import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { RpcError } from "../src/rpc";
import { builtCli, closeBridges, fakeBridge, runAs, tmp } from "./helpers";

let cli: string;
beforeAll(() => {
  cli = builtCli();
});
afterEach(closeBridges);

const hook = (event: string[], env: NodeJS.ProcessEnv, input: string) => runAs(cli, "dorks", ["hook", ...event], env, [], input);
const STOP_INPUT = { session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, cwd: "/work/acme/demo" };

describe("dorks hook", () => {
  it("sends the hook's JSON input to the matching RPC method and prints the answer as the hook output", async () => {
    const answers = { decision: "block", reason: "push first" };
    const b = await fakeBridge({
      "hook.stop": (p) => (b.calls.push({ method: "hook.stop", params: p }), answers),
      "hook.postToolUse": (p) => (b.calls.push({ method: "hook.postToolUse", params: p }), null),
      "hook.sessionStart": (p) => (b.calls.push({ method: "hook.sessionStart", params: p }), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" } }),
    });
    const stop = await hook(["stop"], b.env, JSON.stringify(STOP_INPUT));
    expect(stop).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(stop.stdout)).toEqual(answers);
    expect(stop.stdout.endsWith("\n")).toBe(true);

    const post = { tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: "u", stderr: "" } };
    expect(await hook(["post-tool-use"], b.env, JSON.stringify(post))).toEqual({ code: 0, stdout: "", stderr: "" }); // null answer: no output

    const start = await hook(["session-start"], b.env, JSON.stringify({ source: "startup" }));
    expect(JSON.parse(start.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" } });
    expect(b.calls.map((c) => c.method)).toEqual(["hook.stop", "hook.postToolUse", "hook.sessionStart"]);
    expect(b.calls[0]!.params).toEqual(STOP_INPUT);
    expect(b.calls[1]!.params).toEqual(post);
  });

  it("fails open when the bridge is unreachable: exit 0, nothing on stdout or stderr", async () => {
    const gone = { DORKS_SOCK: join(tmp("gone-"), "cred.sock") };
    for (const event of ["stop", "post-tool-use", "session-start"]) expect(await hook([event], gone, JSON.stringify(STOP_INPUT)), event).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("fails open outside a dork box (no DORKS_SOCK)", async () => {
    expect(await hook(["stop"], {}, JSON.stringify(STOP_INPUT))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("fails open when the bridge refuses, throws, or answers with something that is not a hook output", async () => {
    for (const handler of [
      () => {
        throw new RpcError("unavailable", "the backend did not answer in time");
      },
      () => {
        throw new Error("boom");
      },
      () => "just a string",
      () => 7,
    ]) {
      const b = await fakeBridge({ "hook.stop": handler });
      expect(await hook(["stop"], b.env, JSON.stringify(STOP_INPUT))).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("fails open on input that is not JSON, and never calls the bridge with it", async () => {
    const b = await fakeBridge();
    for (const input of ["", "not json", "{"]) expect(await hook(["stop"], b.env, input), JSON.stringify(input)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(b.calls).toEqual([]);
  });

  it("fails open on an unknown event or none, without calling the bridge", async () => {
    const b = await fakeBridge();
    expect(await hook(["pre-tool-use"], b.env, "{}")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await hook([], b.env, "{}")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(b.calls).toEqual([]);
  });

  it("also runs as a subcommand of the bridge binary, which is how the settings file invokes it", async () => {
    const b = await fakeBridge({ "hook.stop": () => ({ decision: "block", reason: "r" }) });
    const r = await runAs(cli, "dorks-bridge", ["dorks", "hook", "stop"], b.env, [], JSON.stringify(STOP_INPUT));
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "r" });
  });
});
