import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { claudeMcpConfig } from "../src/hooks";
import { McpServer } from "../src/mcp";
import { RpcError } from "../src/rpc";
import { builtCli, closeBridges, fakeBridge, fakeView, tmp } from "./helpers";

afterEach(closeBridges);

const call = (s: McpServer, name: string, args: unknown, id = 1) => s.handle(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })) as Promise<any>;
const text = (r: any) => r.result.content[0].text as string;

describe("MCP protocol", () => {
  const server = () => new McpServer({ DORKS_SOCK: "/nowhere" });
  const rpc = (s: McpServer, method: string, params?: unknown) => s.handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method, params })) as Promise<any>;

  it("initialize answers with the requested protocol version when it is one we speak, the newest otherwise", async () => {
    const a = await rpc(server(), "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
    expect(a.result.protocolVersion).toBe("2025-06-18");
    expect(a.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(a.result.serverInfo.name).toBe("dorks");
    expect((await rpc(server(), "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
  });

  it("answers ping, rejects unknown methods, and never answers notifications", async () => {
    expect((await rpc(server(), "ping")).result).toEqual({});
    expect((await rpc(server(), "resources/list")).error.code).toBe(-32601);
    expect(await server().handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(await server().handle(JSON.stringify({ jsonrpc: "2.0", method: "nope" }))).toBeNull();
  });

  it("rejects malformed input with a JSON-RPC error", async () => {
    expect(((await server().handle("{not json")) as any).error.code).toBe(-32700);
    expect(((await server().handle("[1]")) as any).error.code).toBe(-32600);
    expect(((await server().handle(JSON.stringify({ id: 1 }))) as any).error.code).toBe(-32600);
  });

  it("lists the PR, preview and machine tools with object schemas and hints, without leaking the handlers", async () => {
    const { tools } = (await rpc(server(), "tools/list")).result;
    expect(tools.map((t: any) => t.name)).toEqual([
      "pr_subscribe",
      "pr_unsubscribe",
      "pr_list",
      "preview_show",
      "screenshot_share",
      "machine_get",
      "machine_draft",
      "machine_run",
      "machine_logs",
      "machine_submit",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t).not.toHaveProperty("run");
    }
    expect(tools.find((t: any) => t.name === "pr_subscribe").inputSchema.required).toEqual(["pr"]);
    expect(tools.find((t: any) => t.name === "pr_list").annotations.readOnlyHint).toBe(true);
  });
});

describe("MCP tools", () => {
  it("pr_subscribe forwards to pr.sub as the agent, for a URL or owner/name#n", async () => {
    const b = await fakeBridge();
    const s = new McpServer(b.env);
    expect(text(await call(s, "pr_subscribe", { pr: "https://github.com/acme/demo/pull/12" }))).toContain("Subscribed to acme/demo#12");
    expect(text(await call(s, "pr_subscribe", { pr: "acme/other#3" }))).toContain("Subscribed to acme/other#3");
    expect(b.calls).toEqual([
      { method: "pr.sub", params: { repo: "acme/demo", number: 12, source: "agent" } },
      { method: "pr.sub", params: { repo: "acme/other", number: 3, source: "agent" } },
    ]);
  });

  it("pr_unsubscribe forwards to pr.unsub", async () => {
    const b = await fakeBridge();
    const r = await call(new McpServer(b.env), "pr_unsubscribe", { pr: "acme/demo#12" });
    expect(r.result).toEqual({ content: [{ type: "text", text: "Unsubscribed from acme/demo#12." }], isError: false });
    expect(b.calls).toEqual([{ method: "pr.unsub", params: { repo: "acme/demo", number: 12 } }]);
  });

  it("pr_list prints the same entries as `dorks pr list`, filters with `pr` (case-insensitively), and says when there are none", async () => {
    const subs = [
      { ...fakeView({ repo: "acme/demo", number: 12 }), title: "Fix login", ci: "failing", review: "changes_requested", mergeable: false, ciFixAttempts: 1 },
      { ...fakeView({ repo: "acme/other", number: 3 }), ci: "passing", review: "approved", mergeable: true, status: "stalled" },
    ];
    const b = await fakeBridge({ "pr.list": () => subs });
    const s = new McpServer(b.env);
    expect(text(await call(s, "pr_list", {}))).toBe(
      [
        "acme/demo#12  open  ci failing, review changes_requested, has conflicts, ci fix attempts 1  Fix login",
        "  https://github.com/acme/demo/pull/12",
        "acme/other#3  open  ci passing, review approved, mergeable, STALLED (needs a human)",
        "  https://github.com/acme/other/pull/3",
      ].join("\n"),
    );
    expect(text(await call(s, "pr_list", { pr: "ACME/Other#3" }))).toMatch(/^acme\/other#3 /);
    expect(text(await call(s, "pr_list", { pr: "acme/demo#99" }))).toBe("You are not subscribed to acme/demo#99.");
    const empty = await fakeBridge();
    expect(text(await call(new McpServer(empty.env), "pr_list", undefined))).toBe("No PR subscriptions.");
  });

  it("bad arguments are tool errors the agent can read, and never reach the bridge", async () => {
    const b = await fakeBridge();
    const s = new McpServer(b.env);
    for (const [tool, args] of [
      ["pr_subscribe", {}],
      ["pr_subscribe", { pr: 12 }],
      ["pr_subscribe", { pr: "acme/demo" }],
      ["pr_unsubscribe", { pr: "https://example.com/a/b/pull/1" }],
      ["pr_list", { pr: "nope" }],
      ["pr_subscribe", null],
    ] as const) {
      const r = await call(s, tool, args);
      expect(r.result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(text(r)).toMatch(/`pr` must be/);
    }
    expect(b.calls).toEqual([]);
    const unknown = await call(s, "pr_merge", {});
    expect(unknown.result.isError).toBe(true);
    expect(text(unknown)).toContain('Unknown tool "pr_merge"');
  });

  it("backend and bridge problems come back as tool errors with the bridge's own message", async () => {
    const b = await fakeBridge({
      "pr.sub": () => {
        throw new RpcError("unavailable", "the backend did not answer in time");
      },
    });
    const r = await call(new McpServer(b.env), "pr_subscribe", { pr: "acme/demo#1" });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toBe("the backend did not answer in time");
    const gone = await call(new McpServer({ DORKS_SOCK: join(tmp("gone-"), "cred.sock") }), "pr_list", {});
    expect(text(gone)).toBe("cannot reach the dorks bridge in this box");
    expect(text(await call(new McpServer({}), "pr_list", {}))).toContain("DORKS_SOCK is not set");
  });
});

describe("machine tools", () => {
  it("forward to the bridge's build method as one action each, and a refusal comes back as a tool error", async () => {
    const run = { id: "r1", kind: "trial", status: "succeeded", step: null, error: null, exitCode: 0, startedBy: "dork:d", createdAt: 1, finishedAt: 2 };
    const actions: string[] = [];
    const b = await fakeBridge({
      build: (p: any) => {
        actions.push(p.action);
        if (p.action === "run") return run;
        if (p.action === "logs") return { run, log: "== done" };
        if (p.action === "submit") throw new RpcError("failed", "There is no draft to submit. Write one with machine_draft first.");
        return { build: null, draft: null };
      },
    });
    const s = new McpServer(b.env);
    expect(text(await call(s, "machine_run", {}))).toContain("Started a trial run (r1)");
    expect(text(await call(s, "machine_logs", { tail: 5 }))).toContain("trial run r1: succeeded\n\n== done");
    expect(text(await call(s, "machine_get", {}))).toContain("base machine");
    const refused = await call(s, "machine_submit", { note: "adds jq" });
    expect(refused.result.isError).toBe(true);
    expect(text(refused)).toContain("no draft to submit");
    expect(actions).toEqual(["run", "logs", "get", "submit"]);
  });
});

describe("the built `dorks mcp` over stdio", () => {
  let cli: string;
  beforeAll(() => {
    cli = builtCli();
  });

  it("speaks newline-delimited JSON-RPC on stdin/stdout, as Claude Code drives it, and exits when stdin closes", async () => {
    const b = await fakeBridge({ "pr.list": () => [fakeView({ repo: "acme/demo", number: 4 })] });
    const cfg = claudeMcpConfig([process.execPath, cli], b.sock).mcpServers.dorks;
    const bin = tmp("bin-");
    symlinkSync(process.execPath, join(bin, "node"));
    const child = spawn(cfg.command, cfg.args, { env: { PATH: bin, ...cfg.env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    const exited = new Promise<number | null>((res) => child.on("close", res));

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pr_subscribe", arguments: { pr: "acme/demo#4" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pr_list", arguments: {} } });
    child.stdin.end();

    expect(await exited).toBe(0);
    const replies = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]); // the notification got no reply, the rest are in order
    expect(replies[0].result.protocolVersion).toBe("2025-06-18");
    expect(replies[1].result.tools).toHaveLength(10);
    expect(replies[2].result.content[0].text).toContain("Subscribed to acme/demo#4");
    expect(replies[3].result.content[0].text).toContain("acme/demo#4");
    expect(b.calls[0]).toEqual({ method: "pr.sub", params: { repo: "acme/demo", number: 4, source: "agent" } });
  });
});
