import type { Context } from "hono";
import { Effect, Schema } from "effect";
import * as builds from "../../services/builds";
import * as runs from "../../services/buildRuns";
import { body, intQuery, looseBody, ok, service, serviceAsync } from "../route";
import { handler, id, Loose, name, type Routes } from "./shared";

const RunKind = Schema.Struct({ kind: Schema.Literals(["image", "trial"]) });
const Approve = Schema.Struct({ reviewed: Loose, run: Loose });
const Reject = Schema.Struct({ reason: Loose });
const Default = Schema.Struct({ default: Loose });

const runId = (c: Context) => c.req.param("runId") as string;
const draftId = (c: Context) => c.req.param("draftId") as string;

// ---- builds (docs/builds.md)
export const buildRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/builds",
    on((c) => serviceAsync(builds.listBuilds).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/builds",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => service((a) => builds.createBuild(a, b))),
        Effect.map((buildId) => c.json({ id: buildId }, 201)),
      ),
    ),
  );
  api.get(
    "/api/builds/:id",
    on((c) => serviceAsync((a) => builds.buildView(a, builds.ownBuild(a, id(c)))).pipe(Effect.map((v) => c.json(v)))),
  );
  api.patch(
    "/api/builds/:id",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => service((a) => builds.updateBuild(a, id(c), b))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/builds/:id",
    on((c) => ok(c)(service((a) => builds.deleteBuild(a, id(c))))),
  );
  api.put(
    "/api/builds/:id/default",
    on((c) =>
      body(c, Default).pipe(
        Effect.flatMap((b) => service((a) => builds.setDefaultBuild(a, b.default === false ? null : id(c)))),
        ok(c),
      ),
    ),
  );
  api.put(
    "/api/builds/:id/vars/:name",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => builds.setBuildVar(a, id(c), name(c), b))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/builds/:id/vars/:name",
    on((c) => ok(c)(service((a) => builds.deleteBuildVar(a, id(c), name(c))))),
  );
  api.get(
    "/api/builds/:id/runs",
    on((c) => service((a) => c.json(builds.listRuns(a, id(c))))),
  );
  api.post(
    "/api/builds/:id/runs",
    on((c) =>
      body(c, RunKind, "kind must be image or trial").pipe(
        Effect.flatMap(({ kind }) => service((a) => runs.startRun(a, id(c), { kind, by: "owner" }))),
        Effect.map((run) => c.json(run, 202)),
      ),
    ),
  );
  api.get(
    "/api/builds/:id/runs/:runId/log",
    on((c) => intQuery(c, "after").pipe(Effect.flatMap((after) => service((a) => c.json(runs.runLog(a, id(c), runId(c), after ?? 0)))))),
  );
  api.post(
    "/api/builds/:id/runs/:runId/cancel",
    on((c) => ok(c)(service((a) => runs.cancelRun(a, id(c), runId(c))))),
  );
  api.post(
    "/api/builds/:id/drafts/:draftId/approve",
    on((c) =>
      Effect.gen(function* () {
        const b = yield* body(c, Approve);
        const { missing } = yield* serviceAsync((a) => builds.approveDraft(a, id(c), draftId(c), b.reviewed));
        // Build right away unless the owner said not to, or a value the setup needs is still missing (the owner fills it in, then builds).
        const run = b.run !== false && !missing.length ? yield* service((a) => runs.startRun(a, id(c), { kind: "image", by: "owner" })) : null;
        return c.json({ run, missing });
      }),
    ),
  );
  api.post(
    "/api/builds/:id/drafts/:draftId/reject",
    on((c) =>
      body(c, Reject).pipe(
        Effect.flatMap((b) => service((a) => builds.rejectDraft(a, id(c), draftId(c), b.reason))),
        ok(c),
      ),
    ),
  );
};
