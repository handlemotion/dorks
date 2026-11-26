import { z } from "zod";
import type { BuildRepo, BuildService, BuildSpec, DraftVar, MachineType } from "./builds";
import { machineType } from "./builds";

// What an agent's change to its build differs in (docs/builds.md): a line diff of scripts, and the repositories, services and variables
// it adds, removes or changes. The build's page diffs a draft live; the chat keeps a summary taken when the agent submitted it.

export type DiffLine = { kind: " " | "+" | "-"; text: string };

/** A line diff (longest common subsequence); scripts are short, so the quadratic table is fine up to a sane size. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a ? a.replace(/\n$/, "").split("\n") : [];
  const y = b ? b.replace(/\n$/, "").split("\n") : [];
  if (x.length * y.length > 400_000) return [...x.map((text) => ({ kind: "-" as const, text })), ...y.map((text) => ({ kind: "+" as const, text }))];
  const t = Array.from({ length: x.length + 1 }, () => Array.from({ length: y.length + 1 }, () => 0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: " ", text: x[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: "-", text: x[i++] });
    else out.push({ kind: "+", text: y[j++] });
  }
  while (i < x.length) out.push({ kind: "-", text: x[i++] });
  while (j < y.length) out.push({ kind: "+", text: y[j++] });
  return out;
}

/** Repositories the draft adds, removes or changes (branch or setup). */
export function repoChangesOf(was: BuildRepo[], now: BuildRepo[]) {
  const before = new Map(was.map((r) => [r.repo, r]));
  const after = new Map(now.map((r) => [r.repo, r]));
  return [
    ...now.filter((r) => !before.has(r.repo)).map((r) => ({ r, what: "Added" as const })),
    ...was.filter((r) => !after.has(r.repo)).map((r) => ({ r, what: "Removed" as const })),
    ...now
      .filter((r) => {
        const b = before.get(r.repo);
        return b && ((b.branch ?? "") !== (r.branch ?? "") || (b.setupScript ?? "") !== (r.setupScript ?? ""));
      })
      .map((r) => ({ r, what: "Changed" as const })),
  ];
}

/** Services the draft adds, removes or changes (command, directory, port or preview). */
export function serviceChangesOf(was: BuildService[], now: BuildService[]) {
  const key = (s: BuildService) => JSON.stringify([s.command, s.cwd ?? "", s.port ?? null, !!s.preview]);
  const before = new Map(was.map((s) => [s.name, s]));
  const after = new Map(now.map((s) => [s.name, s]));
  return [
    ...now.filter((s) => !before.has(s.name)).map((s) => ({ s, what: "Added" as const })),
    ...was.filter((s) => !after.has(s.name)).map((s) => ({ s, what: "Removed" as const })),
    ...now.filter((s) => before.has(s.name) && key(before.get(s.name)!) !== key(s)).map((s) => ({ s, what: "Changed" as const })),
  ];
}

export const changeWhat = z.enum(["Added", "Removed", "Changed"]);
export type ChangeWhat = z.infer<typeof changeWhat>;

/** How many script lines a chat card keeps: past it, a line says how many more there are. */
const MAX_CARD_LINES = 400;
/** Unchanged lines kept around each change; longer runs fold into one "…" line. */
const CONTEXT = 2;

/**
 * A submitted draft's changes as the chat card shows them: taken at submission, so the card still reads right once the draft became the
 * build (or was rejected and the proposed build deleted). The script is hunks: changed lines with {@link CONTEXT} lines around them,
 * each fold a `…` line saying how many lines it hides. Never holds a secret's value (a draft has none).
 */
export const draftChanges = z.object({
  script: z.object({ added: z.number(), removed: z.number(), lines: z.array(z.object({ kind: z.enum([" ", "+", "-", "…"]), text: z.string() })) }).optional(),
  repos: z.array(z.object({ name: z.string(), what: changeWhat })).optional(),
  services: z.array(z.object({ name: z.string(), what: changeWhat })).optional(),
  vars: z.array(z.object({ name: z.string(), what: changeWhat, secret: z.boolean() })).optional(),
  size: z.object({ from: machineType, to: machineType }).optional(),
});
export type DraftChanges = z.infer<typeof draftChanges>;
export type CardLine = NonNullable<DraftChanges["script"]>["lines"][number];

/** Changed lines with a little context; runs of unchanged lines between them fold into one line. */
export function scriptHunks(lines: DiffLine[]): CardLine[] {
  const near = lines.map((_, i) => lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.kind !== " "));
  const out: CardLine[] = [];
  let folded = 0;
  const fold = () => {
    if (folded) out.push({ kind: "…", text: `${folded} unchanged line${folded === 1 ? "" : "s"}` });
    folded = 0;
  };
  lines.forEach((l, i) => {
    if (!near[i]) return void folded++;
    fold();
    out.push(l);
  });
  fold();
  if (out.length <= MAX_CARD_LINES) return out;
  const more = out.length - MAX_CARD_LINES;
  return [...out.slice(0, MAX_CARD_LINES), { kind: "…", text: `${more} more line${more === 1 ? "" : "s"}` }];
}

/** What a draft changes against its build, for the chat card. Absent fields: nothing changed there. */
export function draftChangesOf(
  was: Pick<BuildSpec, "setupScript" | "repos" | "services"> & { machineType: MachineType },
  now: Pick<BuildSpec, "setupScript" | "repos" | "services"> & { machineType: MachineType },
  vars: DraftVar[],
  existingVars: string[],
): DraftChanges {
  const out: DraftChanges = {};
  if (was.setupScript !== now.setupScript) {
    const lines = diffLines(was.setupScript, now.setupScript);
    out.script = { added: lines.filter((l) => l.kind === "+").length, removed: lines.filter((l) => l.kind === "-").length, lines: scriptHunks(lines) };
  }
  const repos = repoChangesOf(was.repos, now.repos).map(({ r, what }) => ({ name: r.repo, what }));
  if (repos.length) out.repos = repos;
  const services = serviceChangesOf(was.services, now.services).map(({ s, what }) => ({ name: s.name, what }));
  if (services.length) out.services = services;
  const had = new Set(existingVars);
  if (vars.length) out.vars = vars.map((v) => ({ name: v.name, what: v.remove ? "Removed" : had.has(v.name) ? "Changed" : "Added", secret: v.secret }));
  if (was.machineType !== now.machineType) out.size = { from: was.machineType, to: now.machineType };
  return out;
}
