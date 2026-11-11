import { fail, type App } from "../app";
import { getDork } from "../data";
import { buildView, dorkBuild, draftView, submitDraft, writeDraft } from "./builds";
import { runLog, startRunForDork, type RunRow } from "./buildRuns";

// The `build` bridge op: what the agent's machine_* MCP tools reach (docs/builds.md, "Agent tooling"). Every action is resolved from the
// authenticated dork id, so an agent can only ever see or change a draft of its own dork's build; there is no build id to forge. Nothing
// here returns a secret value: views carry plain values only, and logs are redacted when they are stored.

const MAX_LOG_CHARS = 64 * 1024;

export async function buildOp(app: App, dorkId: string, args: Record<string, unknown>): Promise<unknown> {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return fail("forbidden", "forbidden");
  switch (args.action) {
    case "get": {
      const b = dorkBuild(app, dorkId);
      if (!b) return { build: null, draft: null };
      return { build: { ...(await buildView(app, b)), drafts: undefined }, draft: draftView(app, b.id, dorkId) };
    }
    case "draft":
      return writeDraft(app, dorkId, args.draft);
    case "run": {
      const kind = args.kind === "image" ? "image" : args.kind === "trial" || args.kind === undefined ? "trial" : fail("invalid", "kind must be trial or image");
      return startRunForDork(app, dorkId, kind);
    }
    case "logs":
      return logs(app, dorkId, args);
    case "submit":
      return submitDraft(app, dorkId, args.note);
    default:
      return fail("invalid", "unknown build action");
  }
}

function logs(app: App, dorkId: string, args: Record<string, unknown>) {
  const b = dorkBuild(app, dorkId);
  if (!b) return fail("not_configured", "This session runs on the base machine, not on a build.");
  const runId = typeof args.runId === "string" ? args.runId : app.db.get<RunRow>("SELECT * FROM build_runs WHERE build_id = ? ORDER BY created_at DESC LIMIT 1", b.id)?.id;
  if (!runId) return fail("not_found", "This build has no runs yet. Start one with machine_run.");
  const { text, run } = runLog(app, b.id, runId);
  let lines = text.split("\n");
  if (typeof args.grep === "string" && args.grep) {
    // A plain, case-insensitive substring: a regular expression from the agent would run on the server.
    const needle = args.grep.toLowerCase().slice(0, 200);
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }
  const tail = typeof args.tail === "number" && args.tail > 0 ? Math.min(Math.trunc(args.tail), 5000) : 200;
  let out = lines.slice(-tail).join("\n");
  if (out.length > MAX_LOG_CHARS) out = out.slice(-MAX_LOG_CHARS);
  return { run, log: out };
}

