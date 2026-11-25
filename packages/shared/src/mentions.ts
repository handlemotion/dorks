import { z } from "zod";

// What the composer's `/` and `@` menus offer (docs/architecture.md, "Mentions"): the agent's commands and skills, and the files of
// the session's repository. Both come from the box: the bridge relays the CLI's own command list and a `git ls-files` listing.

/** One slash command or skill the agent offers, as Claude Code's `initialize` answer lists it. */
export const agentCommand = z.object({
  name: z.string().regex(/^[\w.:-]{1,80}$/),
  description: z.string().max(300).optional(),
  /** What it takes after its name (`[issue description]`), when the command says. */
  argumentHint: z.string().max(200).optional(),
});
export type AgentCommand = z.infer<typeof agentCommand>;
export const MAX_AGENT_COMMANDS = 300;

/** At most this many paths are relayed, in this many bytes: one frame stays well under the server's 256 KB event cap. */
export const MAX_FILE_PATHS = 5000;
export const MAX_FILE_BYTES = 180 * 1024;
export const filePath = z.string().min(1).max(1024);

const score = (path: string, q: string): number => {
  const p = path.toLowerCase();
  const slash = p.lastIndexOf("/");
  const base = p.slice(slash + 1);
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (p.startsWith(q)) return 3;
  if (p.includes(q)) return 4;
  // The letters in order (`chcomp` finds ChatComposer.tsx), anywhere in the path.
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 5 : -1;
};

/**
 * The paths that match `query` best: the file's own name before its folders, a prefix before a match inside, then the letters in
 * order; shorter paths first within a rank. Without a query, the shallowest paths. Case-insensitive.
 */
export function rankFiles(paths: readonly string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase();
  const depth = (p: string) => p.split("/").length;
  if (!q) return [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, limit);
  const hits: { p: string; s: number }[] = [];
  for (const p of paths) {
    const s = score(p, q);
    if (s >= 0) hits.push({ p, s });
  }
  hits.sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return hits.slice(0, limit).map((h) => h.p);
}
