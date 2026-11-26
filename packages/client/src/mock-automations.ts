// The mock server's automations (docs/automations.md): CRUD, Run now and a run history, in memory, so the Automations pages work
// under `pnpm dev:mock`. Nothing fires by itself here: schedules and repository events need the real server (`pnpm dev`). Like the
// mock server, it imports nothing at runtime.
import { randomUUID } from "node:crypto";
import type { AutomationRunView, AutomationTrigger, AutomationView } from "@dorks/shared";

type Body = Record<string, unknown>;
type Answer = { status: number; body: unknown } | { error: "invalid" | "not_found"; message: string };

interface Deps {
  broadcast: (m: Record<string, unknown>) => void;
  /** Starts a session the way POST /api/dorks does; returns its id and title, or why it cannot start. */
  startSession: (repo: string, message: string, title: string) => { id: string; title: string } | { error: string };
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The same rules the server applies, in short. */
function check(b: Body): string | null {
  if (typeof b.name !== "string" || !b.name.trim()) return "Name the automation.";
  if (!Array.isArray(b.triggers) || b.triggers.length === 0) return "Add a trigger.";
  // As the server: every trigger names a repository.
  if ((b.triggers as AutomationTrigger[]).some((t) => !REPO.test(t?.repo ?? ""))) return "Choose a repository for every trigger.";
  if (typeof b.instructions !== "string" || !b.instructions.trim()) return "Write what the agent should do.";
  return null;
}

export function mockAutomations({ broadcast, startSession }: Deps) {
  const items = new Map<string, AutomationView>();
  const runs = new Map<string, AutomationRunView[]>();
  const changed = () => broadcast({ t: "automations" });

  /** Saves a whole definition (a PATCH merges over the saved one first). */
  const save = (id: string, b: Body, createdAt = Date.now()): AutomationView => {
    const enabled = b.enabled !== false;
    const a: AutomationView = {
      id,
      name: String(b.name).trim(),
      enabled,
      triggers: b.triggers as AutomationTrigger[],
      instructions: String(b.instructions).trim(),
      model: (b.model as string | null) ?? null,
      effort: (b.effort as string | null) ?? null,
      buildId: (b.buildId as string | null) ?? null,
      // A stand-in an hour out: the mock does no calendar math.
      nextRunAt: enabled && (b.triggers as AutomationTrigger[]).some((t) => t.kind === "schedule") ? Date.now() + 3_600_000 : null,
      lastRun: runs.get(id)?.[0] ?? null,
      recentRuns: runs.get(id)?.length ?? 0,
      problems: [],
      publicRepos: [],
      createdAt,
      updatedAt: Date.now(),
    };
    items.set(id, a);
    changed();
    return a;
  };

  const runNow = (a: AutomationView): Answer => {
    const t = a.triggers[0];
    if (!t) return { error: "invalid", message: "Add a trigger first: it names the repository." };
    const started = startSession(
      t.repo ?? "",
      `${a.instructions}\n\n---\nThis session was started by the automation "${a.name}"${t.repo ? ` in ${t.repo}` : ""}. You started this run by hand, to try it.`,
      `${a.name}: Run by you`,
    );
    if ("error" in started) return { error: "invalid", message: started.error };
    const run: AutomationRunView = {
      id: randomUUID(),
      automationId: a.id,
      source: "manual",
      summary: "Run by you",
      url: null,
      repo: t.repo ?? null,
      status: "started",
      error: null,
      dork: { id: started.id, title: started.title, state: "creating", archived: false },
      createdAt: Date.now(),
    };
    runs.set(a.id, [run, ...(runs.get(a.id) ?? [])]);
    items.set(a.id, { ...a, lastRun: run, recentRuns: (runs.get(a.id) ?? []).length });
    changed();
    return { status: 201, body: run };
  };

  /** Answers `/api/automations[/:id[/runs]]`, or undefined for any other path. */
  return (method: string, path: string, body: Body): Answer | undefined => {
    const m = /^\/api\/automations(?:\/([^/]+)(\/runs)?)?$/.exec(path);
    if (!m) return undefined;
    const [, id, sub] = m;
    if (!id) {
      if (method === "GET") return { status: 200, body: [...items.values()].sort((x, y) => x.name.localeCompare(y.name)) };
      if (method !== "POST") return { error: "not_found", message: "Unknown route." };
      const problem = check(body);
      if (problem) return { error: "invalid", message: problem };
      return { status: 201, body: { id: save(randomUUID(), body).id } };
    }
    const a = items.get(decodeURIComponent(id));
    if (!a) return { error: "not_found", message: "This automation no longer exists." };
    if (sub) return method === "POST" ? runNow(a) : { status: 200, body: runs.get(a.id) ?? [] };
    if (method === "GET") return { status: 200, body: a };
    if (method === "DELETE") {
      items.delete(a.id);
      runs.delete(a.id);
      changed();
      return { status: 200, body: {} };
    }
    if (method !== "PATCH") return { error: "not_found", message: "Unknown route." };
    const problem = check({ ...a, ...body });
    if (problem) return { error: "invalid", message: problem };
    save(a.id, { ...a, ...body }, a.createdAt);
    return { status: 200, body: {} };
  };
}
