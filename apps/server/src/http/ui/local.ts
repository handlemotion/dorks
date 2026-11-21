import { Effect, Schema } from "effect";
import { owned } from "../../services/dorks";
import { decideLocal, localAccessView, revokeGrant, revokeGrants, setLocalAccess } from "../../services/local";
import { body, ok, service } from "../route";
import { handler, id, Loose, type Routes } from "./shared";

const LocalDecision = Schema.Struct({ decision: Loose, minutes: Loose });
const Enabled = Schema.Struct({ enabled: Loose });

// ---- local access: the agent's requests to use this computer (services/local.ts, docs/local-access.md)
export const localRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.post(
    "/api/dorks/:id/local/:requestId",
    on((c) =>
      body(c, LocalDecision).pipe(
        Effect.flatMap((b) => service((a) => decideLocal(a, owned(a, id(c)).id, c.req.param("requestId") as string, b.decision, b.minutes))),
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
    "/api/local-access/grants",
    on((c) => ok(c)(service((a) => revokeGrants(a, c.req.query("dork") || undefined)))),
  );
  api.delete(
    "/api/local-access/grants/:grantId",
    on((c) => ok(c)(service((a) => revokeGrant(a, c.req.param("grantId") as string)))),
  );
};
