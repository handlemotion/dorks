import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newTranslateState, opencodeConfig, translate, type Translation } from "../src/opencode";

// The translator against event streams captured from a real `opencode serve` 1.19.3 driving a mock OpenAI-compatible provider
// (test/fixtures/opencode/*.jsonl: one SSE `data:` payload per line, noise events such as plugin.added removed).

const replay = (name: string) => {
  const events = readFileSync(join(__dirname, "fixtures/opencode", `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sid = events.map((e) => e.properties?.sessionID).find(Boolean) as string;
  const st = newTranslateState();
  const out: Translation[] = events.map((e) => translate(e, sid, st));
  return { sid, out, events: out.flatMap((t) => t.events), all: events };
};

describe("translate (real OpenCode captures)", () => {
  it("a turn with text, a bash call and a second step: deltas, final texts, tool use + result, idle", () => {
    const { out, events } = replay("success");
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(deltas).toBe("Let me read the file.The file says: hello world.");
    expect(events.filter((e) => e.type === "text")).toEqual([
      expect.objectContaining({ type: "text", text: "Let me read the file." }),
      expect.objectContaining({ type: "text", text: "The file says: hello world." }),
    ]);
    // each text part is its own message: the final text replaces exactly the deltas streamed under the same id
    const texts = events.filter((e) => e.type === "text") as { messageId: string }[];
    expect(new Set(texts.map((t) => t.messageId)).size).toBe(2);
    expect(events.filter((e) => e.type === "tool_use")).toEqual([{ type: "tool_use", toolId: "call_mock_1", name: "bash", input: { command: "cat hello.txt", description: "Print hello.txt" } }]);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([{ type: "tool_result", toolId: "call_mock_1", ok: true, output: "hello world\n" }]);
    expect(out.filter((t) => t.bash)).toEqual([expect.objectContaining({ bash: { command: "cat hello.txt", output: "hello world\n" } })]);
    expect(out.filter((t) => t.idle)).toHaveLength(1);
    expect(out.some((t) => t.error)).toBe(false);
  });

  it("never echoes our own prompt back as assistant text", () => {
    const { events } = replay("success");
    expect(JSON.stringify(events)).not.toContain("read hello.txt");
  });

  it("an abort: partial text, no error (the user asked for it), idle twice", () => {
    const { out, events } = replay("abort");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(3);
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
    expect(out.some((t) => t.error)).toBe(false);
    expect(out.filter((t) => t.idle).length).toBe(2); // why the harness debounces idle
    expect(JSON.stringify(events)).not.toContain("second msg while busy"); // a queued user message is not assistant output either
  });

  it("a permission request is surfaced for the harness to answer", () => {
    const { out } = replay("permission");
    expect(out.filter((t) => t.permission).map((t) => t.permission)).toEqual([expect.stringMatching(/^per_/)]);
  });

  it("a rejected permission ends the tool in error, and the loop goes on", () => {
    const { events } = replay("permission-reject");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, output: expect.stringContaining("rejected permission") });
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("a provider rate limit that OpenCode retries is reported once, with when it retries", () => {
    const { events } = replay("ratelimit");
    expect(events.filter((e) => e.type === "rate_limited")).toEqual([{ type: "rate_limited", resetsAt: expect.any(Number) }]);
  });

  it("a provider auth failure is the turn's error, first line only", () => {
    const { out } = replay("401");
    const errors = out.map((t) => t.error).filter(Boolean);
    expect(errors[0]).toMatch(/^APIError: /);
    expect(errors.every((e) => !e!.includes("\n"))).toBe(true);
  });

  it("ignores other sessions' events and junk", () => {
    const { all } = replay("success");
    const st = newTranslateState();
    expect(all.flatMap((e) => translate(e, "ses_other", st).events)).toEqual([]);
    expect(translate("nope", "s", st)).toEqual({ events: [] });
    expect(translate({ type: "session.idle" }, "s", st)).toEqual({ events: [] });
  });
});

describe("opencodeConfig", () => {
  it("runs unattended with the dorks MCP server and the chosen model", () => {
    const c = opencodeConfig({ model: "anthropic/claude-sonnet-4-5", mcpServer: { command: ["/node", "/cli.mjs", "dorks", "mcp"], env: { DORKS_SOCK: "/s" } } });
    expect(c).toMatchObject({
      autoupdate: false,
      share: "disabled",
      model: "anthropic/claude-sonnet-4-5",
      permission: { edit: "allow", bash: "allow" },
      mcp: { dorks: { type: "local", command: ["/node", "/cli.mjs", "dorks", "mcp"], environment: { DORKS_SOCK: "/s" }, enabled: true } },
    });
    expect(opencodeConfig({ model: null, mcpServer: { command: [], env: {} } })).not.toHaveProperty("model");
  });
});
