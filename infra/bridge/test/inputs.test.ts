import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { SecretInputs } from "../src/inputs";
import { Redactor } from "../src/redact";

// Secure inputs (docs/secure-inputs.md): a reference becomes the value only in what the tool runs, and the value never comes back.

const password = `p@ss w'rd $HOME "x"`;
function setup() {
  const values: Record<string, string> = {};
  const t = { input: async (a: Record<string, unknown>) => (a.action === "values" ? { values } : { requestId: "i1", status: "provided" }), errorCode: () => undefined };
  const redactor = new Redactor();
  return { values, redactor, inputs: new SecretInputs(t, redactor, () => {}) };
}
const updated = (out: unknown) => (out as { hookSpecificOutput: { updatedInput?: Record<string, unknown>; permissionDecision?: string } }).hookSpecificOutput;

describe("secure inputs in the bridge", () => {
  it("fills a Bash command through a shell variable, so any value survives the shell as typed", async () => {
    const s = setup();
    s.values.password = password;
    const out = updated(await s.inputs.preToolUse({ tool_name: "Bash", tool_input: { command: 'printf %s "{{secret:password}}"', description: "{{secret:password}}" } }));
    expect(out.updatedInput!.description).toBe("{{secret:password}}"); // only the command runs with it
    expect(execFileSync("bash", ["-c", out.updatedInput!.command as string], { encoding: "utf8" })).toBe(password);
  });

  it("fills other tools' inputs, leaves the dorks tools alone, and stops a call that names an unknown value", async () => {
    const s = setup();
    s.values.password = password;
    const typed = updated(await s.inputs.preToolUse({ tool_name: "mcp__playwright__browser_type", tool_input: { ref: "e3", text: "{{secret:password}}" } }));
    expect(typed.updatedInput).toEqual({ ref: "e3", text: password });
    expect(await s.inputs.preToolUse({ tool_name: "mcp__dorks__input_request", tool_input: { description: "{{secret:password}}" } })).toBeNull();
    expect(updated(await s.inputs.preToolUse({ tool_name: "Write", tool_input: { content: "{{secret:otp}}" } })).permissionDecision).toBe("deny");
    s.values.otp = "424242"; // the owner answered meanwhile: an unknown name is fetched before it is refused
    expect(updated(await s.inputs.preToolUse({ tool_name: "Write", tool_input: { content: "{{secret:otp}}" } })).updatedInput).toEqual({ content: "424242" });
  });

  it("redacts a value and its encodings from any tool's output, the transcript and logs", async () => {
    const s = setup();
    s.values.password = password;
    await s.inputs.refresh();
    expect(s.inputs.postToolUse({ tool_name: "Read", tool_response: { file: { content: "ok" } } })).toBeNull();
    const response = { stdout: `${password}\n${Buffer.from(password).toString("base64")}\n${encodeURIComponent(password)}\nok`, stderr: "", interrupted: false, isImage: false };
    const out = s.inputs.postToolUse({ tool_name: "Bash", tool_response: response }) as { hookSpecificOutput: { updatedToolOutput: typeof response } };
    expect(out.hookSpecificOutput.updatedToolOutput).toEqual({ ...response, stdout: "[redacted]\n[redacted]\n[redacted]\nok" });
    expect(JSON.stringify(s.inputs.scrubDeep({ message: { content: [{ type: "tool_result", content: `got ${password}` }] } }))).not.toContain("p@ss");
    expect(s.redactor.scrub(password)).toBe("[redacted]");
  });

  it("redacts a value inside a larger encoded string, and keeps redacting a value after it was replaced", async () => {
    const s = setup();
    s.values.password = "new-test-password";
    await s.inputs.refresh();
    const header = `> Authorization: Basic ${Buffer.from("user:new-test-password").toString("base64")}`; // curl -v -u "user:{{secret:password}}"
    expect(s.inputs.scrub(header)).toBe("> Authorization: Basic [redacted]");
    expect(s.inputs.scrub("> Authorization: Basic dXNlcjpvdGhlcg==")).toBe("> Authorization: Basic dXNlcjpvdGhlcg=="); // user:other
    s.values.password = "a-fresh-password"; // asked again under the same name
    await s.inputs.refresh();
    expect(s.inputs.scrub("old new-test-password, new a-fresh-password")).toBe("old [redacted], new [redacted]");
  });
});
