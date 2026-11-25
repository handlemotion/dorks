import { SECRET_REF } from "@dorks/shared";
import { shellQuote } from "./credentials";
import { callBackend } from "./prs";
import { errTag, type Log, type Redactor } from "./redact";
import { RpcError, type RpcMethods } from "./rpc";
import type { Transport } from "./transport";

// Secure inputs (docs/secure-inputs.md), the bridge's side. The owner's values live only in this process's memory (fetched from the
// backend over the authenticated socket) and never in the agent's environment, a file or the CLI's config. The agent writes
// `{{secret:NAME}}` in a tool's input; Claude Code's hooks (hooks.ts) call in here:
//   PreToolUse   swaps each reference for its value in the input the tool runs with (the model keeps the input it wrote). For Bash
//                the command gets `${DORKS_SECRET_NAME}` and an `export` of the value in front, so a value is never pasted into
//                shell syntax.
//   PostToolUse  replaces the value (and its common encodings) with [redacted] in what the tool returns, for every tool, so a value
//                echoed, written to a file and read back, or printed by a server never reaches the model.
// The transcript (Bridge.onRaw) and the bridge's logs are scrubbed the same way.

/** Shorter values would shred ordinary output; a 4-digit code is the shortest worth hiding. */
const MIN_SCRUB = 4;
const REDACTED = "[redacted]";
/** The `dorks` MCP server's own tools take references as text (a request's description), never values. */
const OWN_TOOLS = "mcp__dorks__";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The forms a value commonly takes in output: as typed, base64 (a Basic auth header), URL-encoded, JSON-escaped. */
export function variants(value: string): string[] {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const all = [value, b64, b64.replace(/=+$/, ""), b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
  return [...new Set(all)].filter((v) => v.length >= MIN_SCRUB);
}

/** Every string in `v` through `f`, keeping the shape (a tool's output must keep its own). */
export function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  const o = obj(v);
  return o ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, mapStrings(x, f)])) : v;
}

const refsIn = (s: string) => [...new Set([...s.matchAll(SECRET_REF)].map((m) => m[1]!))];
const envName = (name: string) => `DORKS_SECRET_${name}`;

export class SecretInputs {
  private values = new Map<string, string>();
  /** Every form of every value, longest first (so a value containing another is masked whole). */
  private masks: string[] = [];

  constructor(
    private t: Pick<Transport, "input" | "errorCode">,
    private redactor: Redactor,
    private log: Log,
  ) {}

  get size() {
    return this.values.size;
  }

  /** Fetches this session's values from the backend (after the owner answered, after a restart, or for a name not known yet). */
  async refresh() {
    const r = obj(await callBackend(this.t as Transport, this.log, () => this.t.input({ action: "values" })));
    const values = obj(r?.values) ?? {};
    for (const [name, value] of Object.entries(values)) if (typeof value === "string") this.values.set(name, value);
    const masks = new Set<string>();
    for (const v of this.values.values()) for (const m of variants(v)) masks.add(m);
    this.masks = [...masks].sort((a, b) => b.length - a.length);
    this.redactor.addAll(this.masks);
  }

  /** Replaces every form of every value with [redacted]. */
  scrub(text: string): string {
    let out = text;
    for (const m of this.masks) if (out.includes(m)) out = out.split(m).join(REDACTED);
    return out;
  }

  scrubDeep<T>(v: T): T {
    return this.masks.length ? (mapStrings(v, (s) => this.scrub(s)) as T) : v;
  }

  /** The local RPC behind the input_* MCP tools: forwarded to the backend; once the owner answered, the values are fetched. */
  readonly methods: RpcMethods = {
    input: async (params) => {
      const p = obj(params) ?? {};
      if (p.action !== "request" && p.action !== "wait") throw new RpcError("invalid", "unknown input action");
      const r = await callBackend(this.t as Transport, this.log, () => this.t.input(p), true);
      if (obj(r)?.status === "provided") await this.refresh().catch((e) => this.log("could not fetch the inputs:", errTag(e)));
      return r;
    },
  };

  // ------------------------------------------------------------------ hooks

  /** PreToolUse: the tool runs with the values in place of their references. A reference to an unknown name stops the call. */
  async preToolUse(input: Json): Promise<Json | null> {
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolInput = obj(input.tool_input);
    if (!toolInput || tool.startsWith(OWN_TOOLS)) return null;
    const isBash = tool === "Bash";
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const names = refsIn(isBash ? command : JSON.stringify(toolInput));
    if (!names.length) return null;
    if (names.some((n) => !this.values.has(n))) await this.refresh().catch((e) => this.log("could not fetch the inputs:", errTag(e)));
    const missing = names.filter((n) => !this.values.has(n));
    if (missing.length) {
      const list = missing.map((n) => `{{secret:${n}}}`).join(", ");
      return pre({ permissionDecision: "deny", permissionDecisionReason: `The user has not given a value for ${list}. Ask for it with the input_request tool first.` });
    }
    this.log("hook pre-tool-use: filled", names.length, "secure input(s) for", isBash ? "Bash" : "a tool");
    if (isBash) {
      const exports = names.map((n) => `export ${envName(n)}=${shellQuote(this.values.get(n)!)}`).join("; ");
      const body = command.replace(SECRET_REF, (_m, n: string) => `\${${envName(n)}}`);
      return pre({ updatedInput: { ...toolInput, command: `${exports}\n${body}` } });
    }
    return pre({ updatedInput: mapStrings(toolInput, (s) => s.replace(SECRET_REF, (m, n: string) => this.values.get(n) ?? m)) });
  }

  /** PostToolUse: the tool's output without any value in it. Null when there was nothing to hide. */
  postToolUse(input: Json): Json | null {
    if (!this.masks.length || input.tool_response === undefined) return null;
    const scrubbed = this.scrubDeep(input.tool_response);
    if (JSON.stringify(scrubbed) === JSON.stringify(input.tool_response)) return null;
    this.log("hook post-tool-use: redacted a secure input from a tool's output");
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: scrubbed } };
  }
}

const pre = (out: Json) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } });
