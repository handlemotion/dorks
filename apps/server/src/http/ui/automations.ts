import { Effect } from "effect";
import * as automations from "../../services/automations";
import { sentryProjects } from "../../services/automationSentry";
import { looseBody, ok, service, serviceAsync } from "../route";
import { handler, id, type Routes } from "./shared";

// ---- automations (docs/automations.md)
export const automationRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/automations",
    on((c) => service((a) => c.json(automations.listAutomations(a)))),
  );
  api.post(
    "/api/automations",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => service((a) => automations.createAutomation(a, b))),
        Effect.map((automationId) => c.json({ id: automationId }, 201)),
      ),
    ),
  );
  api.get(
    "/api/automations/:id",
    on((c) => service((a) => c.json(automations.getAutomationView(a, id(c))))),
  );
  api.patch(
    "/api/automations/:id",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => service((a) => automations.updateAutomation(a, id(c), b))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/automations/:id",
    on((c) => ok(c)(service((a) => automations.deleteAutomation(a, id(c))))),
  );
  api.get(
    "/api/automations/:id/runs",
    on((c) => service((a) => c.json(automations.listRuns(a, id(c))))),
  );
  api.get(
    "/api/sentry/projects",
    on((c) => serviceAsync((a) => sentryProjects(a)).pipe(Effect.map((projects) => c.json(projects)))),
  );
  api.post(
    "/api/automations/:id/runs",
    on((c) => service((a) => c.json(automations.runNow(a, id(c)), 201))),
  );
};
