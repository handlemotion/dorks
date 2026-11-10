import { spawn } from "node:child_process";
import { asIdentity, type Identity } from "./runas";

// Names a dork after its first message with a small, cheap model: Haiku through the Claude CLI, or the lightest model the Codex
// account lists. Runs beside the agent, never in its session, so nothing of it reaches the transcript.

const TIMEOUT_MS = 45_000;

export function titlePrompt(message: string): string {
  return [
    "Name this coding chat. Reply with the name only: 5 to 7 words, sentence case, plain words that say what the task is.",
    "No quotes, no trailing period, no emoji, no preamble.",
    "",
    "<message>",
    message.slice(0, 4000),
    "</message>",
  ].join("\n");
}

/** The model's reply as a title: first non-empty line, no wrapping quotes or trailing period. Empty when unusable. */
export function cleanTitle(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  let t = line.replace(/\s+/g, " ").replace(/^(title|name)\s*:\s*/i, "");
  t = t.replace(/^["'`*“‘#\s]+|["'`*”’\s]+$/g, "").replace(/[.!。]+$/, "").trim();
  const words = t.split(" ").filter(Boolean);
  if (!words.length || words.length > 10 || t.length > 80) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * One headless Claude turn on Haiku: no tools, no settings, MCP servers or hooks from the box (only the env's OAuth token), and
 * no transcript on disk. Resolves to the raw reply, or rejects on a non-zero exit or the timeout.
 */
export function claudeOneShot(o: { bin: string; env: NodeJS.ProcessEnv; cwd: string; runAs: Identity | null; prompt: string }): Promise<string> {
  const args = ["-p", "--model", "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text"];
  const [bin, argv] = asIdentity(o.runAs, o.bin, args);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out = (out + d).slice(0, 4096); });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}`));
    });
    child.stdin.end(o.prompt);
  });
}

/** The lightest model for a title, from what the Codex account lists: a "luna" model, then a mini or nano one, else none. */
export function lightCodexModel(models: Map<string, string[]>): { model: string; effort: string } | null {
  const ids = [...models.keys()];
  const pick = ids.find((m) => /luna/i.test(m)) ?? ids.find((m) => /mini|nano|lite|flash/i.test(m));
  if (!pick) return null;
  return { model: pick, effort: lowestEffort(models.get(pick) ?? []) };
}

export function lowestEffort(efforts: string[]): string {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].find((e) => efforts.includes(e)) ?? "low";
}
