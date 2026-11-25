import type { Block, NoticeHook } from "@dorks/shared";

// How the thread names tool calls and autonomy notices: the desktop's wording (apps/web ChatBlock.tsx, lib/hooks.ts), condensed.

/** What a tool did, as a verb and a countable noun. */
function toolAction(name: string): { verb: string; one: string; many: string } {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  const known: Record<string, [string, string, string]> = {
    Bash: ["ran", "a command", "commands"],
    Read: ["read", "a file", "files"],
    Write: ["wrote", "a file", "files"],
    Edit: ["edited", "a file", "files"],
    MultiEdit: ["edited", "a file", "files"],
    NotebookEdit: ["edited", "a file", "files"],
    Grep: ["searched", "the code", "the code"],
    Glob: ["searched", "the code", "the code"],
    WebSearch: ["searched", "the web", "the web"],
    WebFetch: ["fetched", "a page", "pages"],
    Task: ["ran", "an agent", "agents"],
    Agent: ["ran", "an agent", "agents"],
    TodoWrite: ["updated", "the plan", "the plan"],
  };
  const k = known[name];
  if (k) return { verb: k[0], one: k[1], many: k[2] };
  const tool = (mcp?.[1] ?? name).replace(/[_-]+/g, " ");
  return { verb: "used", one: tool, many: tool };
}

/** "Ran 3 commands, read 2 files, edited a file": a run of tool calls in the order each kind first appeared. */
export function toolGroupTitle(tools: { name: string }[]): string {
  const counts = new Map<string, { verb: string; one: string; many: string; n: number }>();
  for (const { name } of tools) {
    const a = toolAction(name);
    const key = `${a.verb} ${a.many}`;
    const seen = counts.get(key);
    if (seen) seen.n++;
    else counts.set(key, { ...a, n: 1 });
  }
  const text = [...counts.values()].map(({ verb, one, many, n }) => `${verb} ${n === 1 ? one : one === many ? many : `${n} ${many}`}`).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One line for an autonomy notice: what happened, in a few words. */
export function hookTitle(hook: NoticeHook): string {
  switch (hook.type) {
    case "pr_opened":
      return `Opened PR #${hook.number}`;
    case "pr_merged":
      return `PR #${hook.number} merged`;
    case "subscription":
      if (hook.status === "stalled") return `Stopped fixing CI on #${hook.number}${hook.reason ? `: ${hook.reason}` : ""}`;
      if (hook.status === "ended") return `Stopped watching #${hook.number}`;
      return `Watching #${hook.number} for CI, reviews and comments`;
    case "notify": {
      if (hook.source === "preview") return "Comments on the preview";
      const prs = hook.prs.map((p) => `#${p.number}`).join(", ") || "your pull request";
      const kind = NOTIFY.find(([k]) => hook.kinds.includes(k as never));
      return kind ? `${kind[1]} on ${prs}` : `Update on ${prs}`;
    }
  }
}

const NOTIFY: [string, string][] = [
  ["ci_failed", "CI failed"],
  ["conflict", "Merge conflicts"],
  ["closed", "Closed"],
  ["review", "New review"],
  ["comment", "New comments"],
  ["base_changed", "Base branch changed"],
  ["ready", "Green and approved"],
  ["ci_passed", "CI passed"],
];

type AgentBlock = Exclude<Block, { kind: "user" }>;
type TurnBlock = Extract<Block, { kind: "turn" }>;
export type Entry = { kind: "user"; block: Extract<Block, { kind: "user" }> } | { kind: "agent"; id: string; blocks: AgentBlock[] };

/** The thread as the desktop groups it: each user message, then everything the agent did until the next one. */
export function entries(blocks: Block[]): Entry[] {
  const out: Entry[] = [];
  for (const block of blocks) {
    if (block.kind === "user") out.push({ kind: "user", block });
    else {
      const last = out.at(-1);
      if (last?.kind === "agent") last.blocks.push(block);
      else out.push({ kind: "agent", id: block.id, blocks: [block] });
    }
  }
  return out;
}

/** A group's turns, each with the `turn` marker that ended it (none while it runs). */
export function turns(blocks: AgentBlock[]): { blocks: AgentBlock[]; end?: TurnBlock }[] {
  const out: { blocks: AgentBlock[]; end?: TurnBlock }[] = [{ blocks: [] }];
  for (const block of blocks) {
    if (block.kind === "turn") {
      out[out.length - 1].end = block;
      out.push({ blocks: [] });
    } else out[out.length - 1].blocks.push(block);
  }
  return out.filter((t) => t.blocks.length > 0 || t.end?.outcome === "stopped");
}

/** A step being worked on, in a few words: the latest running tool call. */
export function currentStep(blocks: Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "tool" && b.status === "running") return toolGroupTitle([b]).replace(/^Ran a command$/, b.summary || "Running a command");
    if (b.kind === "user" || b.kind === "turn") return undefined;
  }
  return undefined;
}
