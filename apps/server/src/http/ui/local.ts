import { Effect, Schema } from "effect";
import { owned } from "../../services/dorks";
import { decideLocal, localAccessView, revokeSessions, setLocalAccess } from "../../services/local";
import { body, ok, service } from "../route";
import { handler, id, Loose, type Routes } from "./shared";

const LocalDecision = Schema.Struct({ decision: Loose });
const Enabled = Schema.Struct({ enabled: Loose });

// ---- local access: the agent's requests to use this computer (services/local.ts, docs/local-access.md)
export const localRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.post(
    "/api/dorks/:id/local/:requestId",
    on((c) =>
      body(c, LocalDecision).pipe(
        Effect.flatMap((b) => service((a) => decideLocal(a, owned(a, id(c)).id, c.req.param("requestId") as string, b.decision))),
        ok(c),
      ),
    ),
  );
  api.get(
    "/api/local-access",
    on((c) => service((a) => c.json(localAccessView(a)))),
  );
  api.put(
    "/api/local-access",
    on((c) =>
      body(c, Enabled).pipe(
        Effect.flatMap((b) => service((a) => setLocalAccess(a, b.enabled))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/local-access/sessions",
    on((c) => ok(c)(service((a) => revokeSessions(a, c.req.query("dork") || undefined)))),
  );
};
